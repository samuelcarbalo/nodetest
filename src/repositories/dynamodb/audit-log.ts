import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { PutCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import { AUDIT_PUT_CONDITION, buildAuditEventKey } from "./audit-table.js";

export type ValidationAudit = {
  validationId: string;
  documentNumber: string;
  occurredAt: Date;
};

export type AuditLog = {
  append(event: ValidationAudit): Promise<void>;
};

export class DynamoAuditLog implements AuditLog {
  constructor(
    private readonly documents: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async append(event: ValidationAudit): Promise<void> {
    const key = buildAuditEventKey({
      documentNumber: event.documentNumber,
      eventType: "VALIDATION_CREATED",
      occurredAt: event.occurredAt,
      eventId: event.validationId,
    });

    await this.documents.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          ...key,
          validationId: event.validationId,
        },
        ConditionExpression: AUDIT_PUT_CONDITION,
      }),
    );
  }
}

export function isConditionalCheckFailed(error: unknown): boolean {
  if (error instanceof ConditionalCheckFailedException) {
    return true;
  }
  return typeof error === "object" && error !== null && "name" in error && error.name === "ConditionalCheckFailedException";
}
