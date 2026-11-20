import { Router } from "express";

import { createValidationsController } from "../controllers/validations.controller.js";
import { asyncHandler, validateCreateBody, validateValidationId } from "../middlewares/validate-request.js";
import type { ValidationService } from "../services/validations.service.js";

export function validationsRouter(service: ValidationService): Router {
  const controller = createValidationsController(service);
  const router = Router();

  router.post("/validations", validateCreateBody, asyncHandler(controller.create));
  router.get("/validations/:id", validateValidationId, asyncHandler(controller.getById));

  return router;
}
