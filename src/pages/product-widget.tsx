import { actions, useAppBridge, useAuthenticatedFetch } from "@saleor/app-sdk/app-bridge";
import { Box, Button, Text } from "@saleor/macaw-ui";
import { NextPage } from "next";
import { useRouter } from "next/router";
import { useCallback, useEffect, useState } from "react";

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

type SuggestionResponse = {
  suggestions: Suggestion[];
  unsupportedInputTypes?: string[];
};

const humanizeSlug = (slug: string) =>
  slug
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * Thin shell: renders nothing until after hydration so that useAppBridge is
 * never called before AppBridgeProvider is mounted.
 */
const ProductWidgetPage: NextPage = () => {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  return <ProductWidgetContent />;
};

const ProductWidgetContent = () => {
  const { appBridgeState, appBridge } = useAppBridge();
  const { query } = useRouter();
  const productId = typeof query.productId === "string" ? query.productId : null;

  /**
   * The bridge is ready when:
   *  1. appBridgeState.ready is true (normal case), OR
   *  2. appBridgeState.token exists — token arriving means auth completed even
   *     if the `ready` event was missed (timing race), OR
   *  3. 3 seconds have passed — fallback so the widget never gets stuck; the
   *     fetch's own error handler will surface any auth failure with a retry.
   */
  const [fallbackReady, setFallbackReady] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setFallbackReady(true), 3000);
    return () => clearTimeout(t);
  }, []);

  const ready =
    Boolean(appBridgeState?.ready) ||
    Boolean(appBridgeState?.token) ||
    fallbackReady;

  if (!ready) {
    return (
      <Box paddingTop={2}>
        <Text size={2} color="default2">
          Loading...
        </Text>
      </Box>
    );
  }

  return <SuggestionsPanel productId={productId} />;
};

/**
 * The widget only renders AI suggestions for missing product attributes.
 *
 * On mount (and whenever `productId` changes), it auto-calls
 * `/api/product-attribute-suggestions`, which:
 *   - loads product context from Saleor server-side
 *   - figures out which attributes are missing
 *   - asks OpenAI (via the Vercel AI SDK) to extract values from the
 *     description — only with explicit textual evidence
 *
 * The user can then apply all returned suggestions in one click.
 */
const SuggestionsPanel = ({ productId }: { productId: string | null }) => {
  const fetch = useAuthenticatedFetch();
  const { appBridge } = useAppBridge();
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [unsupportedInputTypes, setUnsupportedInputTypes] = useState<string[]>([]);
  const [applyStatus, setApplyStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [applyMessage, setApplyMessage] = useState<string | null>(null);

  const loadSuggestions = useCallback(
    async (signal?: AbortSignal) => {
      if (!productId) {
        setStatus("error");
        setError("No productId in URL");
        return;
      }

      setStatus("loading");
      setError(null);
      setApplyStatus("idle");
      setApplyMessage(null);

      try {
        const response = await fetch("/api/product-attribute-suggestions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ productId }),
          signal,
        });
        const body = (await response.json()) as SuggestionResponse | { error: string };

        if (signal?.aborted) return;

        if (!response.ok || "error" in body) {
          throw new Error(
            "error" in body ? body.error : `Request failed with status ${response.status}`
          );
        }

        setSuggestions(body.suggestions);
        setUnsupportedInputTypes(body.unsupportedInputTypes ?? []);
        setStatus("ready");
      } catch (e) {
        if (signal?.aborted || (e instanceof DOMException && e.name === "AbortError")) {
          return;
        }
        setStatus("error");
        setError(e instanceof Error ? e.message : "Unknown error");
      }
    },
    [fetch, productId]
  );

  useEffect(() => {
    if (!productId) return;
    const controller = new AbortController();
    void loadSuggestions(controller.signal);
    return () => controller.abort();
  }, [loadSuggestions, productId]);

  const applySuggestions = useCallback(async () => {
    if (!productId || suggestions.length === 0) return;

    setApplyStatus("loading");
    setApplyMessage(null);

    try {
      const response = await fetch("/api/apply-product-attribute-suggestions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId, suggestions }),
      });
      const body = (await response.json()) as { applied: number } | { error: string };

      if (!response.ok || "error" in body) {
        throw new Error(
          "error" in body ? body.error : `Request failed with status ${response.status}`
        );
      }

      setApplyStatus("done");
      setApplyMessage("Reload the page to see the new values in the form.");
      setSuggestions([]);

      /**
       * Notify the dashboard via AppBridge — this surfaces a native Saleor
       * notification toast outside of the widget iframe.
       *
       * We intentionally do not auto-redirect/reload the parent: the Saleor
       * dashboard caches product data via Apollo, so even an internal
       * navigation (e.g. variants → back) keeps showing stale values until
       * a real browser reload. Asking the user to reload is currently the
       * only fully reliable way to surface the freshly written attributes
       * in the product form, so we make that explicit in the toast.
       */
      appBridge?.dispatch(
        actions.Notification({
          status: "success",
          title: "Attributes updated",
          text: `${body.applied} AI suggestion(s) applied. Reload the page to see them in the form.`,
        })
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : "Unknown error";
      setApplyStatus("error");
      setApplyMessage(message);

      appBridge?.dispatch(
        actions.Notification({
          status: "error",
          title: "Could not apply suggestions",
          text: message,
        })
      );
    }
  }, [appBridge, fetch, productId, suggestions]);

  return (
    <Box paddingTop={2} display="flex" flexDirection="column" gap={2}>
      <Box display="flex" gap={2} alignItems="center" justifyContent="space-between">
        <Text size={2} fontWeight="bold">
          AI Attribute Suggestions
        </Text>
        <Box display="flex" gap={2} alignItems="center">
          <Button
            variant="tertiary"
            onClick={() => void loadSuggestions()}
            disabled={status === "loading" || !productId}
          >
            {status === "loading" ? "Analyzing..." : "Reload"}
          </Button>
          <Button
            variant="primary"
            onClick={() => void applySuggestions()}
            disabled={suggestions.length === 0 || applyStatus === "loading"}
          >
            {applyStatus === "loading" ? "Applying..." : `Apply (${suggestions.length})`}
          </Button>
        </Box>
      </Box>

      {status === "loading" && (
        <Text size={2} color="default2">
          Looking for missing attributes...
        </Text>
      )}

      {status === "error" && error && (
        <Text size={2} color="critical1">
          {error}
        </Text>
      )}

      {applyMessage && (
        <Text size={2} color={applyStatus === "error" ? "critical1" : "default2"}>
          {applyMessage}
        </Text>
      )}

      {status === "ready" && suggestions.length === 0 && (
        <Text size={2} color="default2">
          No grounded suggestions found.
        </Text>
      )}

      {suggestions.map((s) => (
        <Box
          key={`${s.attributeId}-${s.inputType}`}
          display="flex"
          flexDirection="column"
          gap={1}
          borderBottomStyle="solid"
          borderBottomWidth={1}
          paddingBottom={1}
        >
          <Text size={2}>
            <strong>{s.attributeName}</strong>{" "}
            <Text as="span" size={1} color="default2">
              (slug: {s.attributeSlug}, {s.inputType})
            </Text>
          </Text>
          <Text size={2}>
            {s.inputType === "DROPDOWN" && `${humanizeSlug(s.value)} (slug: ${s.value})`}
            {s.inputType === "MULTISELECT" &&
              s.value
                .map((slug) => `${humanizeSlug(slug)} (slug: ${slug})`)
                .join(", ")}
            {s.inputType === "BOOLEAN" && (s.value ? "Yes" : "No")}
            {(s.inputType === "PLAIN_TEXT" || s.inputType === "DATE") && s.value}
          </Text>
          <Text size={1} color="default2">
            Proof from Description: “{s.evidence}”
          </Text>
        </Box>
      ))}

      {unsupportedInputTypes.length > 0 && (
        <Text size={1} color="default2">
          Skipped: {unsupportedInputTypes.join(", ")}
        </Text>
      )}
    </Box>
  );
};

export default ProductWidgetPage;
