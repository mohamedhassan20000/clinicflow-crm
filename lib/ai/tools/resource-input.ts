import "server-only";

import { z } from "zod";
import { MAX_PAGE } from "@/lib/ai/resources/compile";

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const filterValue = z.union([scalar, z.array(scalar).min(1).max(50)]);
const filterClause = z.object({
  operator: z.enum(["eq", "neq", "in", "gt", "gte", "lt", "lte", "ilike", "is"]),
  value: filterValue,
}).strict();

export const resourceFiltersSchema = z
  .record(z.string().trim().min(1).max(80), z.union([filterValue, filterClause]))
  .optional();

export const resourceRelationsSchema = z
  .record(
    z.string().trim().min(1).max(80),
    z.array(z.string().trim().min(1).max(80)).max(20),
  )
  .optional();

export const resourceQueryInputSchema = z.object({
  resource: z.string().trim().min(1).max(80),
  fields: z.array(z.string().trim().min(1).max(80)).min(1).max(40).optional(),
  filters: resourceFiltersSchema,
  relations: resourceRelationsSchema,
  sort: z.string().trim().min(1).max(80).optional(),
  direction: z.enum(["asc", "desc"]).optional(),
  page: z.number().int().min(1).max(MAX_PAGE).optional(),
  page_size: z.number().int().min(1).max(200).optional(),
}).strict();
