import { QueryCommand } from "@aws-sdk/lib-dynamodb";

import { createDocumentClient, createDynamoDbClient } from "../config/dynamodb.js";
import { loadDynamoEnv } from "../config/env.js";
import {
  AUDIT_PARTITION_KEY,
  AUDIT_SORT_KEY,
  buildAuditEventKey,
  ensureAuditTable,
} from "../repositories/dynamodb/audit-table.js";

/**
 * Crea `audit_events` en DynamoDB Local si no existe.
 * ResourceInUseException se trata como éxito: la tabla ya está creada
 * o se está creando. Después se espera a ACTIVE y se comprueba que la
 * clave siga siendo pk (HASH) + sk (RANGE).
 */
async function main(): Promise<void> {
  assertKeyDesign();

  const env = loadDynamoEnv();
  const client = createDynamoDbClient(env);
  const documents = createDocumentClient(client);

  try {
    const result = await ensureAuditTable(client, env.DYNAMODB_AUDIT_TABLE);
    await documents.send(
      new QueryCommand({
        TableName: env.DYNAMODB_AUDIT_TABLE,
        KeyConditionExpression: "#pk = :pk",
        ExpressionAttributeNames: { "#pk": AUDIT_PARTITION_KEY },
        ExpressionAttributeValues: { ":pk": "DOCUMENT#__probe__" },
        Limit: 1,
        ScanIndexForward: true,
      }),
    );

    const status = result === "created" ? "creada" : "ya existía";
    console.log(`Tabla ${env.DYNAMODB_AUDIT_TABLE} lista (${status}).`);
    console.log(`Clave: ${AUDIT_PARTITION_KEY} = DOCUMENT#<numero>, ${AUDIT_SORT_KEY} = DATE#<fecha>`);
  } finally {
    documents.destroy();
  }
}

function assertKeyDesign(): void {
  const earlier = buildAuditEventKey({
    documentNumber: "1042",
    eventType: "signature",
    occurredAt: new Date("2026-11-18T19:05:00.123Z"),
    eventId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
  });
  const later = buildAuditEventKey({
    documentNumber: "1042",
    eventType: "approval",
    occurredAt: new Date("2026-11-18T19:05:00.124Z"),
    eventId: "00000000-0000-4000-8000-000000000000",
  });
  const sameInstant = buildAuditEventKey({
    documentNumber: "1042",
    eventType: "signature",
    occurredAt: new Date("2026-11-18T19:05:00.123Z"),
    eventId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  });

  if (earlier.pk !== "DOCUMENT#1042" || later.pk !== earlier.pk) {
    throw new Error("Partition key must be DOCUMENT#<numero>");
  }
  if (earlier.sk !== "DATE#2026-11-18T19:05:00.123Z") {
    throw new Error(`Unexpected sort key ${earlier.sk}`);
  }
  if (!(earlier.sk < later.sk)) {
    throw new Error("Sort key must order a later DATE# timestamp after an earlier one");
  }
  if (earlier.sk !== sameInstant.sk) {
    throw new Error("Sort key must be DATE#<fecha> for the same timestamp");
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
