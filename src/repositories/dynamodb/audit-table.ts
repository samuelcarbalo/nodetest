import {
  CreateTableCommand,
  DescribeTableCommand,
  ResourceInUseException,
  waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";
import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { QueryCommandInput } from "@aws-sdk/lib-dynamodb";

import { randomUUID } from "node:crypto";

/**
 * Auditoría por documento, ordenada en el tiempo.
 *
 *   pk = DOCUMENT#<numero>
 *   sk = DATE#<fecha>
 *
 * <fecha> es ISO-8601 UTC (`toISOString`). El prefijo DATE# es fijo, así
 * que el orden lexicográfico sigue siendo el cronológico: un Query por
 * `pk` con `ScanIndexForward` devuelve la línea de tiempo del documento.
 *
 * Ejemplo:
 *   pk = DOCUMENT#1042
 *   sk = DATE#2026-11-18T19:05:00.123Z
 */

export const AUDIT_PARTITION_KEY = "pk";
export const AUDIT_SORT_KEY = "sk";
export const AUDIT_DATE_PREFIX = "DATE#";

const DOCUMENT_PREFIX = "DOCUMENT#";
const EVENT_TYPE_PATTERN = /^[A-Z][A-Z0-9_]{0,40}$/;
const MAX_DOCUMENT_NUMBER_LENGTH = 200;

export type AuditEventKeyInput = {
  documentNumber: string;
  eventType: string;
  occurredAt: Date;
  eventId?: string;
};

export type AuditEventKey = {
  pk: string;
  sk: string;
  documentNumber: string;
  eventType: string;
  occurredAt: string;
  eventId: string;
};

export type EnsureAuditTableResult = "created" | "exists";

/**
 * Condición de escritura para el repositorio: si la clave ya existe,
 * la inserción falla en lugar de pisar un evento de auditoría.
 */
export const AUDIT_PUT_CONDITION = "attribute_not_exists(pk) AND attribute_not_exists(sk)";

export function buildAuditEventKey(input: AuditEventKeyInput): AuditEventKey {
  const documentNumber = normalizeDocumentNumber(input.documentNumber);
  const eventType = normalizeEventType(input.eventType);
  const occurredAt = toUtcIsoTimestamp(input.occurredAt);
  const eventId = normalizeEventId(input.eventId ?? randomUUID());

  return {
    pk: `${DOCUMENT_PREFIX}${documentNumber}`,
    sk: `${AUDIT_DATE_PREFIX}${occurredAt}`,
    documentNumber,
    eventType,
    occurredAt,
    eventId,
  };
}

/**
 * Query de la línea de tiempo de un documento.
 * `from` / `to` son inclusivos y se comparan como `DATE#<fecha>`.
 */
export function auditTimelineQuery(
  tableName: string,
  documentNumber: string,
  range?: { from?: Date; to?: Date },
): QueryCommandInput {
  const pk = `${DOCUMENT_PREFIX}${normalizeDocumentNumber(documentNumber)}`;
  const names: Record<string, string> = { "#pk": AUDIT_PARTITION_KEY };
  const values: Record<string, string> = { ":pk": pk };

  let keyCondition = "#pk = :pk";
  const boundsTheTimeline = range?.from !== undefined || range?.to !== undefined;

  if (boundsTheTimeline) {
    names["#sk"] = AUDIT_SORT_KEY;
  }

  if (range?.from && range.to) {
    keyCondition += " AND #sk BETWEEN :from AND :to";
    values[":from"] = auditSortKey(range.from);
    values[":to"] = auditSortKey(range.to);
  } else if (range?.from) {
    keyCondition += " AND #sk >= :from";
    values[":from"] = auditSortKey(range.from);
  } else if (range?.to) {
    keyCondition += " AND #sk <= :to";
    values[":to"] = auditSortKey(range.to);
  }

  return {
    TableName: tableName,
    KeyConditionExpression: keyCondition,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
    ScanIndexForward: true,
  };
}

export async function ensureAuditTable(
  client: DynamoDBClient,
  tableName: string,
): Promise<EnsureAuditTableResult> {
  let result: EnsureAuditTableResult = "created";

  try {
    await client.send(
      new CreateTableCommand({
        TableName: tableName,
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [
          { AttributeName: AUDIT_PARTITION_KEY, AttributeType: "S" },
          { AttributeName: AUDIT_SORT_KEY, AttributeType: "S" },
        ],
        KeySchema: [
          { AttributeName: AUDIT_PARTITION_KEY, KeyType: "HASH" },
          { AttributeName: AUDIT_SORT_KEY, KeyType: "RANGE" },
        ],
      }),
    );
  } catch (error) {
    if (!isResourceInUseException(error)) {
      throw error;
    }
    result = "exists";
  }

  await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName: tableName });
  await assertAuditKeySchema(client, tableName);
  return result;
}

export function isResourceInUseException(error: unknown): boolean {
  if (error instanceof ResourceInUseException) {
    return true;
  }

  return (
    readErrorName(error) === "ResourceInUseException" ||
    readErrorName(errorCause(error)) === "ResourceInUseException"
  );
}

function normalizeDocumentNumber(value: string): string {
  const documentNumber = value.trim();
  if (documentNumber.length === 0 || documentNumber.length > MAX_DOCUMENT_NUMBER_LENGTH) {
    throw new Error(`documentNumber must be 1..${MAX_DOCUMENT_NUMBER_LENGTH} characters`);
  }
  if (documentNumber.includes("#")) {
    throw new Error("documentNumber cannot contain '#': it would break the DOCUMENT# prefix");
  }
  return documentNumber;
}

function normalizeEventType(value: string): string {
  const eventType = value.trim().toUpperCase();
  if (!EVENT_TYPE_PATTERN.test(eventType)) {
    throw new Error("eventType must match [A-Z][A-Z0-9_]{0,40}");
  }
  return eventType;
}

function normalizeEventId(value: string): string {
  const eventId = value.trim();
  if (eventId.length === 0 || eventId.includes("#")) {
    throw new Error("eventId must be a non-empty value without '#'");
  }
  return eventId;
}

function auditSortKey(value: Date): string {
  return `${AUDIT_DATE_PREFIX}${toUtcIsoTimestamp(value)}`;
}

function toUtcIsoTimestamp(value: Date): string {
  const time = value.getTime();
  if (Number.isNaN(time)) {
    throw new Error("occurredAt must be a valid Date");
  }
  return new Date(time).toISOString();
}

async function assertAuditKeySchema(client: DynamoDBClient, tableName: string): Promise<void> {
  const described = await client.send(new DescribeTableCommand({ TableName: tableName }));
  const table = described.Table;
  const keySchema = table?.KeySchema ?? [];
  const hashKey = keySchema.find((key) => key.KeyType === "HASH")?.AttributeName;
  const sortKey = keySchema.find((key) => key.KeyType === "RANGE")?.AttributeName;

  if (hashKey !== AUDIT_PARTITION_KEY || sortKey !== AUDIT_SORT_KEY) {
    throw new Error(
      `Table ${tableName} already exists with key schema ${hashKey ?? "?"}/${sortKey ?? "?"}, expected ${AUDIT_PARTITION_KEY} (HASH) and ${AUDIT_SORT_KEY} (RANGE)`,
    );
  }

  const attributeTypes = new Map(
    (table?.AttributeDefinitions ?? []).map((attribute) => [attribute.AttributeName, attribute.AttributeType]),
  );

  if (attributeTypes.get(AUDIT_PARTITION_KEY) !== "S" || attributeTypes.get(AUDIT_SORT_KEY) !== "S") {
    throw new Error(`Table ${tableName} key attributes must both be strings`);
  }
}

function errorCause(error: unknown): unknown {
  if (typeof error === "object" && error !== null && "cause" in error) {
    return error.cause;
  }
  return undefined;
}

function readErrorName(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "name" in error && typeof error.name === "string") {
    return error.name;
  }
  return undefined;
}
