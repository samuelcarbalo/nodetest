import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ObjectId } from "mongodb";
import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";

import { createApp } from "../src/app.js";
import type { Enrichment } from "../src/domain/validation.js";
import { DynamoAuditLog } from "../src/repositories/dynamodb/audit-log.js";
import { MongoValidationRepository } from "../src/repositories/mongodb/validations.repository.js";
import { CountriesClient } from "../src/services/countries-client.js";
import { ValidationService } from "../src/services/validations.service.js";

const ddbMock = mockClient(DynamoDBDocumentClient);
const documents = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    region: "us-east-1",
    endpoint: "http://127.0.0.1:9",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  }),
);

const colombia = {
  id: 48,
  name: "Colombia",
  iso2: "CO",
  iso3: "COL",
  region: "Americas",
  capital: "Bogotá",
};

const validBody = {
  name: "Ana Pérez",
  documentNumber: "1234567890",
  country: "colombia",
};

describe("POST /validations y GET /validations/:id", () => {
  beforeEach(() => {
    ddbMock.reset();
    ddbMock.on(PutCommand).resolves({});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(() => {
    ddbMock.restore();
  });

  it("crea la validación mockeando la API externa, MongoDB y DynamoDB", async () => {
    const { app, mongo, fetchMock } = harness(async () => jsonResponse([colombia]));

    const response = await request(app).post("/validations").send(validBody);

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      name: "Ana Pérez",
      documentNumber: "1234567890",
      countryQuery: "colombia",
      enrichment: {
        status: "complete",
        country: { commonName: "Colombia", cca2: "CO", capital: "Bogotá" },
      },
    });
    expect(response.body.id).toMatch(/^[a-f0-9]{24}$/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://api.countrystatecity.in/v1/countries");
    expect(init?.headers).toMatchObject({ "X-CSCAPI-KEY": "test-key" });

    expect(mongo.documents).toHaveLength(1);
    expect(mongo.documents[0]?.documentNumber).toBe("1234567890");

    const puts = ddbMock.commandCalls(PutCommand);
    expect(puts).toHaveLength(1);
    expect(puts[0]?.args[0].input.Item).toMatchObject({
      pk: "DOCUMENT#1234567890",
      validationId: response.body.id,
    });
    expect(puts[0]?.args[0].input.Item?.sk).toMatch(/^DATE#/);
  });

  it("responde 400 cuando faltan campos o son inválidos", async () => {
    const { app, mongo, fetchMock } = harness(async () => jsonResponse([colombia]));

    const missing = await request(app).post("/validations").send({ name: "Ana Pérez", country: "colombia" });
    const invalid = await request(app).post("/validations").send({
      name: "A",
      documentNumber: "12",
      country: "colombia",
    });

    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe("VALIDATION_ERROR");
    expect(missing.body.error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "documentNumber" })]),
    );
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "name" }),
        expect.objectContaining({ path: "documentNumber" }),
      ]),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mongo.documents).toHaveLength(0);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it("guarda la validación degradada si la API externa agota el tiempo o falla", async () => {
    const timedOut = harness(hangUntilAbort, 40);
    const timeoutResponse = await request(timedOut.app).post("/validations").send(validBody);

    expect(timeoutResponse.status).toBe(201);
    expect(timeoutResponse.body.enrichment).toEqual({
      status: "degraded",
      reason: "timeout",
      country: null,
    });
    expect(timedOut.mongo.documents).toHaveLength(1);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(1);

    ddbMock.reset();
    ddbMock.on(PutCommand).resolves({});
    vi.unstubAllGlobals();

    const failed = harness(async () => new Response("bad gateway", { status: 502 }));
    const failureResponse = await request(failed.app).post("/validations").send(validBody);

    expect(failureResponse.status).toBe(201);
    expect(failureResponse.body.enrichment).toEqual({
      status: "degraded",
      reason: "unavailable",
      country: null,
    });
    expect(failed.mongo.documents).toHaveLength(1);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(1);
  });

  it("consulta una validación existente y responde 404 si el id no está", async () => {
    const { app } = harness(async () => jsonResponse([colombia]));

    const created = await request(app).post("/validations").send(validBody);
    const found = await request(app).get(`/validations/${created.body.id}`);
    const missing = await request(app).get(`/validations/${new ObjectId().toHexString()}`);

    expect(found.status).toBe(200);
    expect(found.body).toEqual(created.body);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("VALIDATION_NOT_FOUND");
  });
});

function harness(fetchImpl: typeof fetch, timeoutMs = 3_000) {
  const mongo = new MongoCollectionMock();
  const fetchMock = vi.fn(fetchImpl);
  vi.stubGlobal("fetch", fetchMock);

  const app = createApp(
    new ValidationService(
      new CountriesClient("https://api.countrystatecity.in/v1", timeoutMs, "test-key"),
      new MongoValidationRepository(mongo as unknown as ConstructorParameters<typeof MongoValidationRepository>[0]),
      new DynamoAuditLog(documents, "audit_events"),
    ),
  );

  return { app, mongo, fetchMock };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function hangUntilAbort(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const signal = init?.signal;
  return new Promise((_resolve, reject) => {
    const abort = () => reject(new DOMException("The operation was aborted", "AbortError"));
    if (!signal) {
      return;
    }
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

type StoredDocument = {
  _id: ObjectId;
  name: string;
  documentNumber: string;
  countryQuery: string;
  enrichment: Enrichment;
  createdAt: Date;
};

class MongoCollectionMock {
  readonly documents: StoredDocument[] = [];

  async insertOne(document: StoredDocument): Promise<{ acknowledged: true; insertedId: ObjectId }> {
    this.documents.push(document);
    return { acknowledged: true, insertedId: document._id };
  }

  async findOne(filter: { _id: ObjectId }): Promise<StoredDocument | null> {
    return this.documents.find((document) => document._id.equals(filter._id)) ?? null;
  }

  async deleteOne(filter: { _id: ObjectId }): Promise<{ acknowledged: true; deletedCount: number }> {
    const index = this.documents.findIndex((document) => document._id.equals(filter._id));
    if (index >= 0) {
      this.documents.splice(index, 1);
    }
    return { acknowledged: true, deletedCount: index >= 0 ? 1 : 0 };
  }
}
