import { createOpenAI } from "@ai-sdk/openai";
import {
  createProtectedHandler,
  type NextJsProtectedApiHandler,
} from "@saleor/app-sdk/handlers/next";
import { generateObject } from "ai";
import { z } from "zod";

import {
  ProductContextDocument,
  type AssignedProductAttributeFragment,
} from "@/generated/graphql";
import { createClient } from "@/lib/create-graphq-client";
import { saleorApp } from "@/saleor-app";

type ErrorBody = { error: string };

const SUPPORTED_INPUT_TYPES = ["PLAIN_TEXT", "DROPDOWN", "MULTISELECT", "DATE", "BOOLEAN"] as const;
type SupportedInputType = (typeof SUPPORTED_INPUT_TYPES)[number];

const aiSuggestionSchema = z.object({
  suggestions: z.array(
    z.object({
      attributeId: z.string(),
      attributeSlug: z.string(),
      inputType: z.enum(SUPPORTED_INPUT_TYPES),
      evidence: z.string().min(1),
      // OpenAI Responses JSON schema requires every property to be present in `required`.
      // Keep these always present and nullable, then validate/normalize server-side.
      valueString: z.string().nullable(),
      valueStrings: z.array(z.string()).nullable(),
      valueBoolean: z.boolean().nullable(),
    })
  ),
});

type Suggestion =
  | {
      attributeId: string;
      attributeName: string;
      attributeSlug: string;
      inputType: "PLAIN_TEXT";
      value: string;
      evidence: string;
    }
  | {
      attributeId: string;
      attributeName: string;
      attributeSlug: string;
      inputType: "DATE";
      value: string;
      evidence: string;
    }
  | {
      attributeId: string;
      attributeName: string;
      attributeSlug: string;
      inputType: "BOOLEAN";
      value: boolean;
      evidence: string;
    }
  | {
      attributeId: string;
      attributeName: string;
      attributeSlug: string;
      inputType: "DROPDOWN";
      value: string;
      evidence: string;
    }
  | {
      attributeId: string;
      attributeName: string;
      attributeSlug: string;
      inputType: "MULTISELECT";
      value: string[];
      evidence: string;
    };

function normalizeSuggestions(
  raw: z.infer<typeof aiSuggestionSchema>["suggestions"],
  missingAttributeMeta: Record<string, { name: string; slug: string }>
): Suggestion[] {
  const result: Suggestion[] = [];

  for (const s of raw) {
    const meta = missingAttributeMeta[s.attributeId];
    if (!meta) continue;

    switch (s.inputType) {
      case "PLAIN_TEXT": {
        const value = s.valueString?.trim();
        if (!value) break;
        result.push({
          attributeId: s.attributeId,
          attributeName: meta.name,
          attributeSlug: meta.slug,
          inputType: "PLAIN_TEXT",
          value,
          evidence: s.evidence,
        });
        break;
      }
      case "DATE": {
        const value = s.valueString?.trim();
        if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) break;
        result.push({
          attributeId: s.attributeId,
          attributeName: meta.name,
          attributeSlug: meta.slug,
          inputType: "DATE",
          value,
          evidence: s.evidence,
        });
        break;
      }
      case "BOOLEAN": {
        if (typeof s.valueBoolean !== "boolean") break;
        result.push({
          attributeId: s.attributeId,
          attributeName: meta.name,
          attributeSlug: meta.slug,
          inputType: "BOOLEAN",
          value: s.valueBoolean,
          evidence: s.evidence,
        });
        break;
      }
      case "DROPDOWN": {
        const value = s.valueString?.trim();
        if (!value) break;
        result.push({
          attributeId: s.attributeId,
          attributeName: meta.name,
          attributeSlug: meta.slug,
          inputType: "DROPDOWN",
          value,
          evidence: s.evidence,
        });
        break;
      }
      case "MULTISELECT": {
        const value = (s.valueStrings ?? []).map((v) => v.trim()).filter(Boolean);
        if (value.length === 0) break;
        result.push({
          attributeId: s.attributeId,
          attributeName: meta.name,
          attributeSlug: meta.slug,
          inputType: "MULTISELECT",
          value,
          evidence: s.evidence,
        });
        break;
      }
    }
  }

  return result;
}

function getDescriptionText(description: string | null | undefined): string {
  if (!description) return "";
  try {
    const parsed = JSON.parse(description) as {
      blocks?: Array<{ type?: string; data?: Record<string, unknown> }>;
    };
    const blocks = parsed.blocks ?? [];
    const chunks: string[] = [];
    for (const block of blocks) {
      const data = block.data ?? {};
      const text = typeof data.text === "string" ? data.text : null;
      if (text) {
        chunks.push(text.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").trim());
      }
      const items = Array.isArray(data.items) ? data.items : null;
      if (items) {
        for (const item of items) {
          if (typeof item === "string") {
            chunks.push(item.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").trim());
          }
        }
      }
    }
    return chunks.filter(Boolean).join("\n");
  } catch {
    return description;
  }
}

function hasValue(a: AssignedProductAttributeFragment): boolean {
  switch (a.__typename) {
    case "AssignedSingleChoiceAttribute":
      return a.singleChoiceValue != null;
    case "AssignedMultiChoiceAttribute":
      return (a.multiChoiceValue?.length ?? 0) > 0;
    case "AssignedSwatchAttribute":
      return a.swatchValue != null;
    case "AssignedPlainTextAttribute":
      return typeof a.plainTextValue === "string" && a.plainTextValue.trim().length > 0;
    case "AssignedTextAttribute":
      return a.textValue != null;
    case "AssignedNumericAttribute":
      return a.numericValue != null;
    case "AssignedBooleanAttribute":
      return a.booleanValue != null;
    case "AssignedDateAttribute":
      return a.dateValue != null;
    case "AssignedDateTimeAttribute":
      return a.dateTimeValue != null;
    case "AssignedFileAttribute":
      return a.fileValue != null;
    default:
      return true;
  }
}

const handler: NextJsProtectedApiHandler<
  { suggestions: Suggestion[]; unsupportedInputTypes?: string[] } | ErrorBody
> = async (req, res, { authData }) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: "Missing OPENAI_API_KEY env variable" });
  }

  const productId = typeof req.body?.productId === "string" ? req.body.productId : null;
  if (!productId) {
    return res.status(400).json({ error: "Missing productId in body" });
  }

  const client = createClient(authData.saleorApiUrl, async () => ({ token: authData.token }));
  const productContext = await client.query(ProductContextDocument, { id: productId });

  if (productContext.error) {
    return res.status(502).json({ error: productContext.error.message });
  }

  const product = productContext.data?.product;
  if (!product) {
    return res.status(404).json({ error: `Product ${productId} not found` });
  }

  const descriptionText = getDescriptionText(product.description);
  if (!descriptionText.trim()) {
    return res.status(200).json({ suggestions: [] });
  }

  const filledSlugs = new Set(product.assignedAttributes.filter(hasValue).map((a) => a.attribute.slug));
  const missingAttributes = (product.productType.productAttributes ?? []).filter(
    (attr) => !filledSlugs.has(attr.slug)
  );

  const supportedMissingAttributes = missingAttributes.filter((attr) =>
    SUPPORTED_INPUT_TYPES.includes(attr.inputType as SupportedInputType)
  );

  const unsupportedInputTypes: string[] = Array.from(
    new Set(
      missingAttributes
        .map((attr) => attr.inputType)
        .filter((inputType) => Boolean(inputType))
        .filter((inputType) => !SUPPORTED_INPUT_TYPES.includes(inputType as SupportedInputType))
        .map((inputType) => String(inputType))
    )
  );

  if (supportedMissingAttributes.length === 0) {
    return res.status(200).json({ suggestions: [], unsupportedInputTypes });
  }

  const openai = createOpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  const modelName = process.env.OPENAI_MODEL || "gpt-4o-mini";

  const attributesPrompt = supportedMissingAttributes
    .map((attr) => {
      const choices = (attr.choices?.edges ?? [])
        .map((edge) => edge?.node)
        .filter((node): node is NonNullable<typeof node> => Boolean(node));
      return JSON.stringify({
        id: attr.id,
        slug: attr.slug,
        name: attr.name,
        inputType: attr.inputType,
        valueRequired: attr.valueRequired,
        choices: choices.map((choice) => ({
          slug: choice.slug,
          name: choice.name,
        })),
      });
    })
    .join("\n");

  const { object } = await generateObject({
    model: openai(modelName),
    schema: aiSuggestionSchema,
    system: [
      "You extract only explicitly stated facts from product descriptions.",
      "Never invent missing data.",
      "If evidence is weak or absent, do not output a suggestion for that attribute.",
      "For DROPDOWN/MULTISELECT, value must be choice slug(s) from provided list only.",
      "For DATE, output only YYYY-MM-DD when an exact date is explicitly present.",
      "Return only the flat schema fields: valueString, valueStrings, valueBoolean.",
      "Include a short evidence quote copied from the text.",
    ].join(" "),
    prompt: [
      `Product name: ${product.name}`,
      "Description:",
      descriptionText,
      "",
      "Missing attributes (JSON lines):",
      attributesPrompt,
      "",
      "Return suggestions only for attributes supported by clear textual evidence.",
    ].join("\n"),
  });

  const missingAttributeMeta = Object.fromEntries(
    supportedMissingAttributes.map((attr) => [attr.id, { name: attr.name, slug: attr.slug }])
  );
  const suggestions = normalizeSuggestions(object.suggestions, missingAttributeMeta);

  return res.status(200).json({
    suggestions,
    unsupportedInputTypes,
  });
};

export default createProtectedHandler(handler, saleorApp.apl, ["MANAGE_PRODUCTS"]);
