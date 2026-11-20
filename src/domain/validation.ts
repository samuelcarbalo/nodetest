import { z } from "zod";

const OBJECT_ID = /^[a-fA-F0-9]{24}$/;
const NAME = /^[\p{L}][\p{L}\s'.-]*$/u;
const COUNTRY_NAME = /^[\p{L}][\p{L}\s'.(),-]*$/u;
const DOCUMENT_NUMBER = /^[0-9A-Za-z]{5,20}$/;

export function isObjectId(value: string): boolean {
  return OBJECT_ID.test(value);
}

export const objectIdSchema = z
  .string({ required_error: "id es obligatorio", invalid_type_error: "id debe ser texto" })
  .regex(OBJECT_ID, "id debe ser un ObjectId de MongoDB");

export const validationIdParamsSchema = z.object({
  id: objectIdSchema,
});

export const createValidationSchema = z
  .object({
    name: z
      .string({ required_error: "name es obligatorio", invalid_type_error: "name debe ser texto" })
      .trim()
      .min(2, "name debe tener al menos 2 caracteres")
      .max(120, "name admite como máximo 120 caracteres")
      .regex(NAME, "name solo admite letras, espacios, apóstrofos o guiones"),
    documentNumber: z
      .string({
        required_error: "documentNumber es obligatorio",
        invalid_type_error: "documentNumber debe ser texto",
      })
      .trim()
      .regex(DOCUMENT_NUMBER, "documentNumber debe tener de 5 a 20 letras o dígitos"),
    country: z
      .string({ invalid_type_error: "country debe ser texto" })
      .trim()
      .min(2, "country debe tener al menos 2 caracteres")
      .max(60, "country admite como máximo 60 caracteres")
      .regex(COUNTRY_NAME, "country debe ser un nombre de país")
      .default("Colombia"),
  })
  .strict();

export type CreateValidationInput = z.infer<typeof createValidationSchema>;

export type CountrySummary = {
  commonName: string;
  officialName: string;
  cca2: string;
  region: string;
  capital: string | null;
};

export type Enrichment =
  | { status: "complete"; country: CountrySummary }
  | { status: "degraded"; reason: "timeout" | "unavailable"; country: null };

export type Validation = {
  id: string;
  name: string;
  documentNumber: string;
  countryQuery: string;
  enrichment: Enrichment;
  createdAt: string;
};

export type NewValidation = {
  name: string;
  documentNumber: string;
  countryQuery: string;
  enrichment: Enrichment;
};
