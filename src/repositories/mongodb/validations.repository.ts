import { ObjectId, type Collection, type Db } from "mongodb";

import { isObjectId, type Enrichment, type NewValidation, type Validation } from "../../domain/validation.js";

type ValidationDocument = {
  _id: ObjectId;
  name: string;
  documentNumber: string;
  countryQuery: string;
  enrichment: Enrichment;
  createdAt: Date;
};

export type ValidationRepository = {
  insert(input: NewValidation): Promise<Validation>;
  findById(id: string): Promise<Validation | null>;
  deleteById(id: string): Promise<void>;
};

export function createValidationRepository(db: Db): MongoValidationRepository {
  return new MongoValidationRepository(db.collection<ValidationDocument>("validations"));
}

export class MongoValidationRepository implements ValidationRepository {
  private readonly collection: Collection<ValidationDocument>;

  constructor(collection: Collection<ValidationDocument>) {
    this.collection = collection;
  }


  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex({ documentNumber: 1 }, { name: "validations_document_number" });
  }

  async insert(input: NewValidation): Promise<Validation> {
    const document: ValidationDocument = {
      _id: new ObjectId(),
      name: input.name,
      documentNumber: input.documentNumber,
      countryQuery: input.countryQuery,
      enrichment: input.enrichment,
      createdAt: new Date(),
    };
    await this.collection.insertOne(document);
    return toValidation(document);
  }

  async findById(id: string): Promise<Validation | null> {
    if (!isObjectId(id)) {
      return null;
    }
    const document = await this.collection.findOne({ _id: new ObjectId(id) });
    return document ? toValidation(document) : null;
  }

  async deleteById(id: string): Promise<void> {
    if (!isObjectId(id)) {
      return;
    }
    await this.collection.deleteOne({ _id: new ObjectId(id) });
  }
}

function toValidation(document: ValidationDocument): Validation {
  return {
    id: document._id.toHexString(),
    name: document.name,
    documentNumber: document.documentNumber,
    countryQuery: document.countryQuery,
    enrichment: document.enrichment,
    createdAt: document.createdAt.toISOString(),
  };
}
