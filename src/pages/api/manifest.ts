import { createManifestHandler } from "@saleor/app-sdk/handlers/next";
import { AppManifest } from "@saleor/app-sdk/types";

import packageJson from "@/package.json";

import { orderCreatedWebhook } from "./webhooks/order-created";
import { orderFilterShippingMethodsWebhook } from "./webhooks/order-filter-shipping-methods";

/**
 * App SDK helps with the valid Saleor App Manifest creation. Read more:
 * https://github.com/saleor/saleor-app-sdk/blob/main/docs/api-handlers.md#manifest-handler-factory
 */
export default createManifestHandler({
  async manifestFactory({ appBaseUrl, request, schemaVersion }) {
    /**
     * Allow to overwrite default app base url, to enable Docker support.
     *
     * See docs: https://docs.saleor.io/docs/3.x/developer/extending/apps/local-app-development
     */
    const iframeBaseUrl = process.env.APP_IFRAME_BASE_URL ?? appBaseUrl;
    const apiBaseURL = process.env.APP_API_BASE_URL ?? appBaseUrl;


    const manifest: AppManifest = {
      name: "Product AI Assistant",
      tokenTargetUrl: `${apiBaseURL}/api/register`,
      appUrl: iframeBaseUrl,
      /**
       * Set permissions for app if needed
       * https://docs.saleor.io/docs/3.x/developer/permissions
       */
      permissions: [
        /**
         * MANAGE_ORDERS — required for ORDER_CREATED / ORDER_FILTER_SHIPPING_METHODS webhooks
         * and the ORDER_DETAILS_WIDGETS extension.
         * MANAGE_PRODUCTS — required for the PRODUCT_DETAILS_WIDGETS extension. Per-extension
         * permissions can never exceed the app's own permissions, so this must be declared
         * here as well.
         */
        "MANAGE_ORDERS",
        "MANAGE_PRODUCTS",
      ],
      id: "product-ai-assistant",
      version: packageJson.version,
      /**
       * Configure webhooks here. They will be created in Saleor during installation
       * Read more
       * https://docs.saleor.io/docs/3.x/developer/api-reference/webhooks/objects/webhook
       *
       * Easiest way to create webhook is to use app-sdk
       * https://github.com/saleor/saleor-app-sdk/blob/main/docs/saleor-webhook.md
       */
      webhooks: [
        orderCreatedWebhook.getWebhookManifest(apiBaseURL),
        orderFilterShippingMethodsWebhook.getWebhookManifest(apiBaseURL),
      ],
      /**
       * Optionally, extend Dashboard with custom UIs
       * https://docs.saleor.io/docs/3.x/developer/extending/apps/extending-dashboard-with-apps
       */
      extensions: [

        {
          url: iframeBaseUrl + "/product-widget",
          permissions: ["MANAGE_PRODUCTS"],
          mount: "PRODUCT_DETAILS_WIDGETS",
          label: "Product AI Assistant",
          target: "WIDGET",
        },
      ],
      author: "Tilman Marquart | TRWK.de",
      brand: {
        logo: {
          default: `${apiBaseURL}/logo.png`,
        },
      },
    };

    return manifest;
  },
});
