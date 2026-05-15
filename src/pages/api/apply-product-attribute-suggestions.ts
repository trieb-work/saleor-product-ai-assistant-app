import {
  createProtectedHandler,
  type NextJsProtectedApiHandler,
} from "@saleor/app-sdk/handlers/next";
import { z } from "zod";

import { UpdateProductAttributesDocument } from "@/generated/graphql";
import { createClient } from "@/lib/create-graphq-client";
import { saleorApp } from "@/saleor-app";

type ErrorBody = { error: string };

const suggestionSchema = z.discriminatedUnion("inputType", [
  z.object({
    attributeId: z.string(),
    attributeSlug: z.string(),
    inputType: z.literal("PLAIN_TEXT"),
    value: z.string().min(1),
  }),
  z.object({
    attributeId: z.string(),
    attributeSlug: z.string(),
    inputType: z.literal("DATE"),
    value: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
  z.object({
    attributeId: z.string(),
    attributeSlug: z.string(),
    inputType: z.literal("BOOLEAN"),
    value: z.boolean(),
  }),
  z.object({
    attributeId: z.string(),
    attributeSlug: z.string(),
    inputType: z.literal("DROPDOWN"),
    value: z.string().min(1),
  }),
  z.object({
    attributeId: z.string(),
    attributeSlug: z.string(),
    inputType: z.literal("MULTISELECT"),
    value: z.array(z.string().min(1)).min(1),
  }),
]);

const bodySchema = z.object({
  productId: z.string().min(1),
  suggestions: z.array(suggestionSchema),
});

const handler: NextJsProtectedApiHandler<{ applied: number } | ErrorBody> = async (
  req,
  res,
  { authData }
) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request body" });
  }

  const { productId, suggestions } = parsed.data;

  if (suggestions.length === 0) {
    return res.status(200).json({ applied: 0 });
  }

  const attributes = suggestions.map((suggestion) => {
    switch (suggestion.inputType) {
      case "PLAIN_TEXT":
        return {
          id: suggestion.attributeId,
          plainText: suggestion.value,
        };
      case "DATE":
        return {
          id: suggestion.attributeId,
          date: suggestion.value,
        };
      case "BOOLEAN":
        return {
          id: suggestion.attributeId,
          boolean: suggestion.value,
        };
      case "DROPDOWN":
        return {
          id: suggestion.attributeId,
          dropdown: { value: suggestion.value },
        };
      case "MULTISELECT":
        return {
          id: suggestion.attributeId,
          multiselect: suggestion.value.map((choiceSlug) => ({ value: choiceSlug })),
        };
    }
  });

  const client = createClient(authData.saleorApiUrl, async () => ({ token: authData.token }));
  const result = await client.mutation(UpdateProductAttributesDocument, {
    id: productId,
    attributes,
  });

  if (result.error) {
    return res.status(502).json({ error: result.error.message });
  }

  const errors = result.data?.productUpdate?.errors ?? [];
  if (errors.length > 0) {
    const message = errors.map((e) => e.message).filter(Boolean).join("; ") || "Failed to apply suggestions";
    return res.status(400).json({ error: message });
  }

  return res.status(200).json({ applied: suggestions.length });
};

export default createProtectedHandler(handler, saleorApp.apl, ["MANAGE_PRODUCTS"]);
