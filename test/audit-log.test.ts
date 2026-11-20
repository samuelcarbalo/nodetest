import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

import { DynamoAuditLog } from "../src/repositories/dynamodb/audit-log.js";

// Stub DynamoDBDocumentClient, not DynamoDBClient. PutCommand is handled by the
// document client's own send(). A stub on the low-level client never sees it,
// and the call goes to AWS.

const ddbMock = mockClient(DynamoDBDocumentClient);

describe("DynamoAuditLog", () => {
  const documents = DynamoDBDocumentClient.from(
    new DynamoDBClient({
      region: "us-east-1",
      credentials: { accessKeyId: "local", secretAccessKey: "local" },
    }),
  );
  const audit = new DynamoAuditLog(documents, "audit_events");

  beforeEach(() => {
    ddbMock.reset();
  });

  it("sends PutCommand through the document client", async () => {
    ddbMock.on(PutCommand).resolves({});

    await audit.append({
      validationId: "6aff60c30e19f38ce29aec73",
      documentNumber: "1234567890",
      occurredAt: new Date("2026-11-19T20:00:00.000Z"),
    });

    const calls = ddbMock.commandCalls(PutCommand);
    assert.equal(calls.length, 1);
    const input = calls[0]?.args[0].input;
    assert.equal(input?.TableName, "audit_events");
    assert.equal(input?.Item?.PK, "DOCUMENT#1234567890");
    assert.equal(input?.Item?.SK, "DATE#2026-11-19T20:00:00.000Z");
    assert.equal(input?.ConditionExpression, "attribute_not_exists(PK) AND attribute_not_exists(SK)");
  });

  it("propagates ConditionalCheckFailedException from the mocked send", async () => {
    ddbMock.on(PutCommand).rejects(
      new ConditionalCheckFailedException({
        message: "The conditional request failed",
        $metadata: {},
      }),
    );

    await assert.rejects(
      () =>
        audit.append({
          validationId: "6aff60c30e19f38ce29aec73",
          documentNumber: "1234567890",
          occurredAt: new Date("2026-11-19T20:00:00.000Z"),
        }),
      (error: unknown) => error instanceof ConditionalCheckFailedException,
    );
  });
});
