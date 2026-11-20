import type { RequestHandler } from "express";

import { readValidatedBody, readValidationId } from "../middlewares/validate-request.js";
import type { ValidationService } from "../services/validations.service.js";

export function createValidationsController(service: ValidationService) {
  const create: RequestHandler = async (_req, res) => {
    const created = await service.create(readValidatedBody(res.locals));
    res.status(201).json(created);
  };

  const getById: RequestHandler = async (_req, res) => {
    const found = await service.getById(readValidationId(res.locals));
    res.status(200).json(found);
  };

  return { create, getById };
}
