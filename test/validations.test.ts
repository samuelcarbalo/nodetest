import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, describe, it } from "node:test";
import type { AddressInfo } from "node:net";

import { ObjectId } from "mongodb";

import { createApp } from "../src/app.js";
import { HttpError } from "../src/domain/http-error.js";
import { createValidationSchema, isObjectId, type NewValidation, type Validation } from "../src/domain/validation.js";
import type { AuditLog, ValidationAudit } from "../src/repositories/dynamodb/audit-log.js";
import type { ValidationRepository } from "../src/repositories/mongodb/validations.repository.js";
import { CountriesClient, interpretLookup } from "../src/services/countries-client.js";
import type { CountryLookup, CountryLookupClient } from "../src/services/countries-client.js";
import { ValidationService } from "../src/services/validations.service.js";

const colombia = {
  id: 48,
  name: "Colombia",
  iso2: "CO",
  iso3: "COL",
  capital: "Bogotá",
  region: "Americas",
  native: "Colombia",
};

const costaRica = {
  id: 53,
  name: "Costa Rica",
  iso2: "CR",
  capital: "San José",
  region: "Americas",
};

describe("create validation schema", () => {
  it("accepts a trimmed name, document number, and country", () => {
    const parsed = createValidationSchema.parse({
      name: "  Ana Pérez  ",
      documentNumber: " 1234567890 ",
      country: "colombia",
    });
    assert.equal(parsed.name, "Ana Pérez");
    assert.equal(parsed.documentNumber, "1234567890");
    assert.equal(parsed.country, "colombia");
  });

  it("defaults a missing country to Colombia", () => {
    const parsed = createValidationSchema.parse({
      name: "Ana Pérez",
      documentNumber: "1234567890",
    });
    assert.equal(parsed.country, "Colombia");
  });

  it("rejects a missing document number and a short name", () => {
    const missing = createValidationSchema.safeParse({ name: "Ana Pérez", country: "colombia" });
    const short = createValidationSchema.safeParse({
      name: "A",
      documentNumber: "12345",
      country: "colombia",
    });
    assert.equal(missing.success, false);
    assert.equal(short.success, false);
  });
});

describe("object id", () => {
  it("accepts 24 hex characters and rejects anything else", () => {
    assert.equal(isObjectId(new ObjectId().toHexString()), true);
    assert.equal(isObjectId("123456789012"), false);
    assert.equal(isObjectId("not-an-object-id"), false);
  });
});

describe("country lookup interpretation", () => {
  it("reads a CountryStateCity country and matches the name or iso2", () => {
    const byName = interpretLookup("COLOMBIA", 200, [colombia, costaRica]);
    const byCode = interpretLookup("co", 200, [colombia, costaRica]);
    assert.equal(byName.status, "complete");
    assert.equal(byCode.status, "complete");
    if (byName.status === "complete") {
      assert.equal(byName.country.commonName, "Colombia");
      assert.equal(byName.country.officialName, "Colombia");
      assert.equal(byName.country.cca2, "CO");
      assert.equal(byName.country.region, "Americas");
      assert.equal(byName.country.capital, "Bogotá");
    }
    if (byCode.status === "complete") {
      assert.equal(byCode.country.cca2, "CO");
    }
  });

  it("treats an HTTP error or an unusable body as an unavailable dependency", () => {
    assert.deepEqual(interpretLookup("colombia", 401, { message: "unauthorized" }), {
      status: "degraded",
      reason: "unavailable",
    });
    assert.deepEqual(interpretLookup("colombia", 200, { message: "not a list" }), {
      status: "degraded",
      reason: "unavailable",
    });
    assert.deepEqual(interpretLookup("atlantis", 404, "Country not found"), {
      status: "degraded",
      reason: "unavailable",
    });
  });

  it("marks an unknown country and an ambiguous match without calling them outages", () => {
    assert.equal(interpretLookup("atlantis", 200, [colombia]).status, "not_found");
    assert.equal(
      interpretLookup("colombia", 200, [colombia, { ...colombia, id: 99 }]).status,
      "ambiguous",
    );
  });
});

describe("CountriesClient", () => {
  const servers: Server[] = [];

  after(async () => {
    await Promise.all(servers.map((server) => closeServer(server)));
  });

  it("returns timeout when the upstream does not answer within the deadline", async () => {
    const server = createServer((req, res) => {
      req.on("error", () => undefined);
      res.on("error", () => undefined);
    });
    servers.push(server);
    const port = await listen(server);
    const client = new CountriesClient(`http://127.0.0.1:${port}`, 50, "test-key");
    const lookup = await client.lookup("colombia");
    assert.deepEqual(lookup, { status: "degraded", reason: "timeout" });
  });

  it("returns unavailable when the upstream responds with an error", async () => {
    let hits = 0;
    const server = createServer((_req, res) => {
      hits += 1;
      if (hits === 1) {
        res.writeHead(502);
        res.end("bad gateway");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([colombia]));
    });
    servers.push(server);
    const port = await listen(server);
    const client = new CountriesClient(`http://127.0.0.1:${port}`, 1_000, "test-key");
    const lookup = await client.lookup("colombia");
    assert.deepEqual(lookup, { status: "degraded", reason: "unavailable" });
    const recovered = await client.lookup("colombia");
    assert.equal(recovered.status, "complete");
    assert.equal(hits, 2);
  });

  it("loads /countries once with X-CSCAPI-KEY and then serves the cache", async () => {
    let hits = 0;
    const server = createServer((req, res) => {
      hits += 1;
      assert.equal(req.url, "/countries");
      assert.equal(req.headers["x-cscapi-key"], "test-key");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([colombia, costaRica]));
    });
    servers.push(server);
    const port = await listen(server);
    const client = new CountriesClient(`http://127.0.0.1:${port}`, 1_000, "test-key");
    const byName = await client.lookup("colombia");
    const byCode = await client.lookup("cr");
    const unknown = await client.lookup("atlantis");
    assert.equal(byName.status, "complete");
    assert.equal(byCode.status, "complete");
    assert.equal(unknown.status, "not_found");
    assert.equal(hits, 1);
  });

  it("stays degraded when CSC_API_KEY is missing and does not call the API", async () => {
    let hits = 0;
    const server = createServer((_req, res) => {
      hits += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([colombia]));
    });
    servers.push(server);
    const port = await listen(server);
    const client = new CountriesClient(`http://127.0.0.1:${port}`, 1_000, "   ");
    const lookup = await client.lookup("colombia");
    assert.deepEqual(lookup, { status: "degraded", reason: "unavailable" });
    assert.equal(hits, 0);
  });
});

describe("validation flow", () => {
  it("stores a degraded validation when enrichment fails and refuses an unknown country", async () => {
    const repository = new MemoryValidations();
    const audit = new MemoryAudit();
    const service = new ValidationService(new ScriptedCountries(), repository, audit);

    const degraded = await service.create({
      name: "Ana Pérez",
      documentNumber: "1234567890",
      country: "timeoutland",
    });
    assert.equal(degraded.enrichment.status, "degraded");
    assert.equal(repository.rows.length, 1);
    assert.equal(audit.events.length, 1);
    assert.equal(audit.events[0]?.validationId, degraded.id);

    await assert.rejects(
      () => service.create({ name: "Ana Pérez", documentNumber: "1234567890", country: "atlantis" }),
      (error: unknown) => {
        assert.equal(error instanceof HttpError && error.status, 422);
        return true;
      },
    );
    assert.equal(repository.rows.length, 1);
    assert.equal(audit.events.length, 1);
  });

  it("rolls back MongoDB when DynamoDB rejects the audit", async () => {
    const repository = new MemoryValidations();
    const service = new ValidationService(new ScriptedCountries(), repository, new FailingAudit());

    await assert.rejects(
      () => service.create({ name: "Ana Pérez", documentNumber: "1234567890", country: "colombia" }),
      (error: unknown) => {
        assert.equal(error instanceof HttpError && error.code, "AUDIT_UNAVAILABLE");
        assert.equal(error instanceof HttpError && error.status, 503);
        return true;
      },
    );
    assert.equal(repository.rows.length, 0);
  });

  it("reports an inconsistent write when MongoDB cannot undo the insert", async () => {
    const repository = new MemoryValidations(true);
    const service = new ValidationService(new ScriptedCountries(), repository, new FailingAudit());

    await assert.rejects(
      () => service.create({ name: "Ana Pérez", documentNumber: "1234567890", country: "colombia" }),
      (error: unknown) => {
        assert.equal(error instanceof HttpError && error.code, "INCONSISTENT_WRITE");
        return true;
      },
    );
    assert.equal(repository.rows.length, 1);
  });

  it("serves POST /validations and GET /validations/:id", async () => {
    const repository = new MemoryValidations();
    const app = createApp(new ValidationService(new ScriptedCountries(), repository, new MemoryAudit()));
    const server = app.listen(0, "127.0.0.1");
    const port = await ready(server);

    try {
      const invalid = await send(port, "POST", "/validations", { name: "Ana", country: "colombia" });
      assert.equal(invalid.status, 400);
      assert.equal(invalid.body.error.code, "VALIDATION_ERROR");

      const badId = await send(port, "GET", "/validations/123456789012");
      assert.equal(badId.status, 400);
      assert.equal(badId.body.error.code, "INVALID_ID");

      const missing = await send(port, "GET", `/validations/${new ObjectId().toHexString()}`);
      assert.equal(missing.status, 404);

      const created = await send(port, "POST", "/validations", {
        name: "Ana Pérez",
        documentNumber: "1234567890",
        country: "colombia",
      });
      assert.equal(created.status, 201);
      assert.equal(created.body.enrichment.status, "complete");
      assert.equal(created.body.enrichment.country.cca2, "CO");

      const fetched = await send(port, "GET", `/validations/${created.body.id}`);
      assert.equal(fetched.status, 200);
      assert.deepEqual(fetched.body, created.body);

      const degraded = await send(port, "POST", "/validations", {
        name: "Ana Pérez",
        documentNumber: "1234567890",
        country: "timeoutland",
      });
      assert.equal(degraded.status, 201);
      assert.deepEqual(degraded.body.enrichment, { status: "degraded", reason: "timeout", country: null });

      const again = await send(port, "GET", `/validations/${degraded.body.id}`);
      assert.equal(again.status, 200);
      assert.equal(again.body.enrichment.status, "degraded");
    } finally {
      await closeServer(server);
    }
  });
});

class MemoryValidations implements ValidationRepository {
  readonly rows: Validation[] = [];

  constructor(private readonly failDelete = false) {}

  async insert(input: NewValidation): Promise<Validation> {
    const validation: Validation = {
      id: new ObjectId().toHexString(),
      createdAt: new Date().toISOString(),
      ...input,
    };
    this.rows.push(validation);
    return validation;
  }

  async findById(id: string): Promise<Validation | null> {
    return this.rows.find((row) => row.id === id) ?? null;
  }

  async deleteById(id: string): Promise<void> {
    if (this.failDelete) {
      throw new Error("mongo delete failed");
    }
    const index = this.rows.findIndex((row) => row.id === id);
    if (index >= 0) {
      this.rows.splice(index, 1);
    }
  }
}

class MemoryAudit implements AuditLog {
  readonly events: ValidationAudit[] = [];

  async append(event: ValidationAudit): Promise<void> {
    this.events.push(event);
  }
}

class FailingAudit implements AuditLog {
  async append(): Promise<void> {
    throw new Error("dynamo down");
  }
}

class ScriptedCountries implements CountryLookupClient {
  async lookup(name: string): Promise<CountryLookup> {
    if (name === "timeoutland") {
      return { status: "degraded", reason: "timeout" };
    }
    if (name === "atlantis") {
      return { status: "not_found" };
    }
    return {
      status: "complete",
      country: {
        commonName: "Colombia",
        officialName: "Colombia",
        cca2: "CO",
        region: "Americas",
        capital: "Bogotá",
      },
    };
  }
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function ready(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.once("listening", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function send(port: number, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text.length > 0 ? JSON.parse(text) : null };
}
