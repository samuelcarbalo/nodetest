import type { RequestHandler } from "express";
import type { z } from "zod";

import { HttpError, zodIssues } from "../domain/http-error.js";
import { createValidationSchema, validationIdParamsSchema } from "../domain/validation.js";

export const validateCreateBody: RequestHandler = (req, res, next) => {
  const parsed = createValidationSchema.safeParse(req.body);
  if (!parsed.success) {
    next(new HttpError(400, "VALIDATION_ERROR", "El cuerpo de la petición no es válido", zodIssues(parsed.error)));
    return;
  }
  res.locals.validatedBody = parsed.data;
  next();
};

export const validateValidationId: RequestHandler = (req, res, next) => {
  const parsed = validationIdParamsSchema.safeParse(req.params);
  if (!parsed.success) {
    next(new HttpError(400, "INVALID_ID", "id debe ser un ObjectId de MongoDB", zodIssues(parsed.error)));
    return;
  }
  res.locals.validationId = parsed.data.id;
  next();
};

export function asyncHandler(handler: RequestHandler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

export function readValidatedBody(locals: Record<string, unknown>): z.infer<typeof createValidationSchema> {
  const parsed = createValidationSchema.safeParse(locals.validatedBody);
  if (!parsed.success) {
    throw new HttpError(500, "INTERNAL", "Falta el cuerpo validado");
  }
  return parsed.data;
}

export function readValidationId(locals: Record<string, unknown>): string {
  const parsed = validationIdParamsSchema.shape.id.safeParse(locals.validationId);
  if (!parsed.success) {
    throw new HttpError(500, "INTERNAL", "Falta el id validado");
  }
  return parsed.data;
}
