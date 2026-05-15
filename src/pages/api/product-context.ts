import {
  createProtectedHandler,
  type NextJsProtectedApiHandler,
} from "@saleor/app-sdk/handlers/next";

import { ProductContextDocument, ProductContextQuery } from "@/generated/graphql";
import { createClient } from "@/lib/create-graphq-client";
import { saleorApp } from "@/saleor-app";

type ErrorBody = { error: string };

/**
 * Returns context about a product needed by the AI assistant widget:
 *  - the product's name, slug, rich-text description, SEO title and SEO description
 *  - all attributes currently assigned to the product (with their values)
 *  - all attributes defined on the product's type (the set of attributes a
 *    product of this type can be filled with)
 *
 * The handler is protected by `createProtectedHandler`, which:
 *  - verifies the staff user JWT sent by AppBridge in the
 *    `authorization-bearer` header
 *  - looks up the matching app auth data (long-lived app token + saleorApiUrl)
 *    from the APL using the `saleor-api-url` header
 *  - rejects requests where the staff user is missing `MANAGE_PRODUCTS`
 *
 * The long-lived app token is then used for the GraphQL call to Saleor,
 * which avoids passing the staff user's short-lived token through urql.
 */
const handler: NextJsProtectedApiHandler<ProductContextQuery | ErrorBody> = async (
  req,
  res,
  { authData }
) => {
  const productId = typeof req.query.productId === "string" ? req.query.productId : null;

  if (!productId) {
    return res.status(400).json({ error: "Missing productId query parameter" });
  }

  const client = createClient(authData.saleorApiUrl, async () => ({
    token: authData.token,
  }));

  const result = await client.query(ProductContextDocument, { id: productId });

  if (result.error) {
    console.error("ProductContext query failed", result.error);
    return res.status(502).json({ error: result.error.message });
  }

  if (!result.data?.product) {
    return res.status(404).json({ error: `Product ${productId} not found` });
  }

  return res.status(200).json(result.data);
};

export default createProtectedHandler(handler, saleorApp.apl, ["MANAGE_PRODUCTS"]);
