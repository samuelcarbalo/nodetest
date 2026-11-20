import { HttpError } from "../domain/http-error.js";
import { isObjectId, type CreateValidationInput, type Enrichment, type Validation } from "../domain/validation.js";
import { isConditionalCheckFailed, type AuditLog } from "../repositories/dynamodb/audit-log.js";
import type { ValidationRepository } from "../repositories/mongodb/validations.repository.js";
import type { CountryLookupClient } from "./countries-client.js";

/**
 * El controlador no llama a la API externa: el puerto CountryLookupClient
 * vive aquí. MongoDB es el registro de la validación y DynamoDB el de
 * auditoría. Si MongoDB ya guardó y DynamoDB falla, se borra el documento
 * y la petición responde error. Si ese borrado también falla, la respuesta
 * es INCONSISTENT_WRITE y el id queda en el log para reconciliar.
 */
export class ValidationService {
  constructor(
    private readonly countries: CountryLookupClient,
    private readonly repository: ValidationRepository,
    private readonly audit: AuditLog,
  ) {}

  async create(input: CreateValidationInput): Promise<Validation> {
    const lookup = await this.countries.lookup(input.country);

    if (lookup.status === "not_found") {
      throw new HttpError(422, "UNKNOWN_COUNTRY", `Ningún país coincide con "${input.country}"`);
    }
    if (lookup.status === "ambiguous") {
      throw new HttpError(422, "AMBIGUOUS_COUNTRY", `Más de un país coincide con "${input.country}"`);
    }
    if (lookup.status === "degraded") {
      console.warn(`country enrichment degraded (${lookup.reason}) for "${input.country}"`);
    }

    const enrichment: Enrichment =
      lookup.status === "complete"
        ? { status: "complete", country: lookup.country }
        : { status: "degraded", reason: lookup.reason, country: null };

    const created = await this.repository.insert({
      name: input.name,
      documentNumber: input.documentNumber,
      countryQuery: input.country,
      enrichment,
    });

    try {
      await this.audit.append({
        validationId: created.id,
        documentNumber: created.documentNumber,
        occurredAt: new Date(created.createdAt),
      });
    } catch (error) {
      await this.rollBack(created, error);
    }

    return created;
  }

  async getById(id: string): Promise<Validation> {
    if (!isObjectId(id)) {
      throw new HttpError(400, "INVALID_ID", "id debe ser un ObjectId de MongoDB");
    }

    const found = await this.repository.findById(id);
    if (!found) {
      throw new HttpError(404, "VALIDATION_NOT_FOUND", "Validación no encontrada");
    }
    return found;
  }

  private async rollBack(created: Validation, cause: unknown): Promise<never> {
    const failure = auditFailure(cause);
    try {
      await this.repository.deleteById(created.id);
    } catch (rollbackError) {
      console.error("MongoDB record kept after DynamoDB failure", {
        validationId: created.id,
        documentNumber: created.documentNumber,
        cause: errorText(cause),
        rollbackError: errorText(rollbackError),
      });
      throw new HttpError(
        503,
        "INCONSISTENT_WRITE",
        "La validación quedó guardada en MongoDB sin auditoría en DynamoDB.",
      );
    }

    console.error("DynamoDB audit failed; MongoDB write was rolled back", {
      validationId: created.id,
      documentNumber: created.documentNumber,
      cause: errorText(cause),
    });
    throw new HttpError(failure.status, failure.code, failure.message);
  }
}

function auditFailure(error: unknown): { status: number; code: string; message: string } {
  if (isConditionalCheckFailed(error)) {
    return {
      status: 409,
      code: "AUDIT_CONFLICT",
      message: "Ya existe una auditoría para ese documento en el mismo instante. La validación no se guardó.",
    };
  }
  return {
    status: 503,
    code: "AUDIT_UNAVAILABLE",
    message: "No se pudo registrar la auditoría. La validación no se guardó.",
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

