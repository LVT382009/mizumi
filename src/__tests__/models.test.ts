import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: vi.fn(() => vi.fn(() => "anthropic-model")),
}));

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: vi.fn(() => {
    const instance = vi.fn(() => "openai-model");
    instance.chat = vi.fn(() => "openai-chat-model");
    return instance;
  }),
}));

vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: vi.fn(() => vi.fn(() => "google-model")),
}));

vi.mock("../config.js", () => ({
  requireApiKey: vi.fn(() => "test-api-key"),
  getApiKey: vi.fn(() => "test-api-key"),
}));

import { createModel, createLightModel } from "../models.js";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { requireApiKey } from "../config.js";

function makeConfig(overrides: Partial<{ provider: string; model: string; baseUrl: string }>) {
  return {
    provider: overrides.provider || "anthropic",
    model: overrides.model || "claude-sonnet-4-6",
    baseUrl: overrides.baseUrl || "",
  } as any;
}

describe("createModel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireApiKey).mockReturnValue("test-api-key");
  });

  it("creates Anthropic model and calls createAnthropic", () => {
    const config = makeConfig({ provider: "anthropic", model: "claude-sonnet-4-6" });
    createModel(config);
    expect(createAnthropic).toHaveBeenCalledWith({ apiKey: "test-api-key" });
  });

  it("creates OpenAI model and calls createOpenAI", () => {
    const config = makeConfig({ provider: "openai", model: "gpt-4.1" });
    createModel(config);
    expect(createOpenAI).toHaveBeenCalled();
  });

  it("creates Google model and calls createGoogleGenerativeAI", () => {
    const config = makeConfig({ provider: "google", model: "gemini-2.5-flash" });
    createModel(config);
    expect(createGoogleGenerativeAI).toHaveBeenCalled();
  });

  it("creates OpenRouter model with correct base URL", () => {
    const config = makeConfig({ provider: "openrouter", model: "anthropic/claude-3.5" });
    createModel(config);
    expect(createOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: "https://openrouter.ai/api/v1",
        name: "openrouter",
      })
    );
  });

  it("creates local model with default Ollama base URL", () => {
    const config = makeConfig({ provider: "local", model: "llama3" });
    createModel(config);
    expect(createOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: "http://localhost:11434/v1",
        name: "local",
      })
    );
  });

  it("creates local model with custom base URL from config", () => {
    const config = makeConfig({ provider: "local", model: "llama3", baseUrl: "http://custom:8081/v1" });
    createModel(config);
    expect(createOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: "http://custom:8081/v1",
      })
    );
  });

  it("creates local model with MIZUMI_BASE_URL env fallback", () => {
    process.env.MIZUMI_BASE_URL = "http://env-fallback:1234/v1";
    const config = makeConfig({ provider: "local", model: "llama3" });
    createModel(config);
    expect(createOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: "http://env-fallback:1234/v1",
      })
    );
    delete process.env.MIZUMI_BASE_URL;
  });

  it("creates NVIDIA model with correct base URL", () => {
    const config = makeConfig({ provider: "nvidia", model: "meta/llama-3.3-70b-instruct" });
    createModel(config);
    expect(createOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: "https://integrate.api.nvidia.com/v1",
        name: "nvidia",
      })
    );
  });

  it("creates custom model with configured base URL", () => {
    const config = makeConfig({ provider: "custom", model: "deepseek-v3", baseUrl: "https://api.deepseek.com/v1" });
    createModel(config);
    expect(createOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: "https://api.deepseek.com/v1",
        name: "custom",
      })
    );
  });

  it("throws for custom provider without base_url or env var", () => {
    const config = makeConfig({ provider: "custom", model: "test", baseUrl: "" });
    delete process.env.CUSTOM_BASE_URL;
    expect(() => createModel(config)).toThrow("Custom provider requires base_url");
  });

  it("creates custom model with CUSTOM_BASE_URL env fallback", () => {
    process.env.CUSTOM_BASE_URL = "https://api.together.xyz/v1";
    const config = makeConfig({ provider: "custom", model: "meta-llama/llama-3.3-70b-instruct", baseUrl: "" });
    createModel(config);
    expect(createOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: "https://api.together.xyz/v1",
      })
    );
    delete process.env.CUSTOM_BASE_URL;
  });

  it("calls requireApiKey with the correct provider", () => {
    const config = makeConfig({ provider: "openai", model: "gpt-4.1" });
    createModel(config);
    expect(requireApiKey).toHaveBeenCalledWith("openai");
  });

  it("createModel with openrouter passes correct API key", () => {
    const config = makeConfig({ provider: "openrouter", model: "anthropic/claude-3.5" });
    createModel(config);
    expect(createOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "test-api-key" })
    );
  });

  it("createModel with nvidia passes correct API key", () => {
    const config = makeConfig({ provider: "nvidia", model: "meta/llama-3.3-70b-instruct" });
    createModel(config);
    expect(createOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "test-api-key" })
    );
  });

  it("createModel returns undefined for unknown provider", () => {
    const config = makeConfig({ provider: "unknown-provider" as any, model: "test" });
    const result = createModel(config);
    // No case matches in the switch, function implicitly returns undefined
    expect(result).toBeUndefined();
  });

  it("createModel with google passes API key to createGoogleGenerativeAI", () => {
    const config = makeConfig({ provider: "google", model: "gemini-2.5-flash" });
    createModel(config);
    expect(createGoogleGenerativeAI).toHaveBeenCalledWith({ apiKey: "test-api-key" });
  });

  it("createModel with local uses MIZUMI_BASE_URL over default URL", () => {
    process.env.MIZUMI_BASE_URL = "http://mizumi-host:1234/v1";
    const config = makeConfig({ provider: "local", model: "llama3" });
    createModel(config);
    expect(createOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: "http://mizumi-host:1234/v1",
        name: "local",
      })
    );
    delete process.env.MIZUMI_BASE_URL;
  });

  it("createModel with openrouter uses .chat() method path", () => {
    const config = makeConfig({ provider: "openrouter", model: "anthropic/claude-3.5" });
    createModel(config);
    const instance = vi.mocked(createOpenAI).mock.results[0].value;
    expect(instance.chat).toHaveBeenCalledWith("anthropic/claude-3.5");
  });

  it("createModel with local uses .chat() method path", () => {
    const config = makeConfig({ provider: "local", model: "llama3" });
    createModel(config);
    const instance = vi.mocked(createOpenAI).mock.results[0].value;
    expect(instance.chat).toHaveBeenCalledWith("llama3");
  });

  it("createModel with nvidia uses .chat() method path", () => {
    const config = makeConfig({ provider: "nvidia", model: "meta/llama-3.3-70b-instruct" });
    createModel(config);
    const instance = vi.mocked(createOpenAI).mock.results[0].value;
    expect(instance.chat).toHaveBeenCalledWith("meta/llama-3.3-70b-instruct");
  });

  it("createModel with custom provider uses CUSTOM_BASE_URL env var", () => {
    process.env.CUSTOM_BASE_URL = "https://api.custom-endpoint.com/v1";
    const config = makeConfig({ provider: "custom", model: "test-model", baseUrl: "" });
    createModel(config);
    expect(createOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: "https://api.custom-endpoint.com/v1",
        name: "custom",
      })
    );
    delete process.env.CUSTOM_BASE_URL;
  });
});

describe("createLightModel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireApiKey).mockReturnValue("test-api-key");
  });

  it("returns haiku model for Anthropic provider", () => {
    const config = makeConfig({ provider: "anthropic", model: "claude-sonnet-4-6" });
    createLightModel(config);
    // Should call createAnthropic (not createOpenAI) for haiku
    expect(createAnthropic).toHaveBeenCalledWith({ apiKey: "test-api-key" });
    // The factory function should be called with haiku model name
    const factoryFn = vi.mocked(createAnthropic).mock.results[0].value;
    expect(factoryFn).toHaveBeenCalledWith("claude-haiku-4-5-20251001");
  });

  it("delegates to createModel for OpenAI provider", () => {
    const config = makeConfig({ provider: "openai", model: "gpt-4.1" });
    createLightModel(config);
    expect(createOpenAI).toHaveBeenCalled();
  });

  it("delegates to createModel for Google provider", () => {
    const config = makeConfig({ provider: "google", model: "gemini-2.5-flash" });
    createLightModel(config);
    expect(createGoogleGenerativeAI).toHaveBeenCalled();
  });

  it("delegates to createModel for local provider", () => {
    const config = makeConfig({ provider: "local", model: "llama3" });
    createLightModel(config);
    expect(createOpenAI).toHaveBeenCalled();
  });

  it("delegates to createModel for nvidia provider", () => {
    const config = makeConfig({ provider: "nvidia", model: "meta/llama-3.3-70b-instruct" });
    createLightModel(config);
    expect(createOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ name: "nvidia" })
    );
  });

  it("delegates to createModel for openrouter provider", () => {
    const config = makeConfig({ provider: "openrouter", model: "anthropic/claude-3.5" });
    createLightModel(config);
    expect(createOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ name: "openrouter" })
    );
  });

  it("delegates to createModel for custom provider", () => {
    process.env.CUSTOM_BASE_URL = "https://api.custom.com/v1";
    const config = makeConfig({ provider: "custom", model: "my-model", baseUrl: "" });
    createLightModel(config);
    expect(createOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ name: "custom" })
    );
    delete process.env.CUSTOM_BASE_URL;
  });

  it("createLightModel for anthropic uses haiku model name", () => {
    const config = makeConfig({ provider: "anthropic", model: "claude-opus-4-7" });
    createLightModel(config);
    const factoryFn = vi.mocked(createAnthropic).mock.results[0].value;
    // Light model should always use haiku regardless of main model
    expect(factoryFn).toHaveBeenCalledWith("claude-haiku-4-5-20251001");
  });

  it("createLightModel for anthropic ignores configured model", () => {
    const config = makeConfig({ provider: "anthropic", model: "claude-sonnet-4-6" });
    createLightModel(config);
    // Should NOT use the configured model for light model
    const factoryFn = vi.mocked(createAnthropic).mock.results[0].value;
    expect(factoryFn).not.toHaveBeenCalledWith("claude-sonnet-4-6");
  });
});

describe("createModel config.baseUrl precedence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireApiKey).mockReturnValue("test-api-key");
  });

  it("local provider prefers config.baseUrl over MIZUMI_BASE_URL env", () => {
    process.env.MIZUMI_BASE_URL = "http://env:1234/v1";
    const config = makeConfig({ provider: "local", model: "llama3", baseUrl: "http://config:5678/v1" });
    createModel(config);
    expect(createOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: "http://config:5678/v1",
      })
    );
    delete process.env.MIZUMI_BASE_URL;
  });

  it("custom provider prefers config.baseUrl over CUSTOM_BASE_URL env", () => {
    process.env.CUSTOM_BASE_URL = "http://env-custom:9999/v1";
    const config = makeConfig({ provider: "custom", model: "deepseek", baseUrl: "http://config-custom:8080/v1" });
    createModel(config);
    expect(createOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: "http://config-custom:8080/v1",
      })
    );
    delete process.env.CUSTOM_BASE_URL;
  });

  it("local provider falls back to MIZUMI_BASE_URL when config.baseUrl is empty", () => {
    process.env.MIZUMI_BASE_URL = "http://fallback:1234/v1";
    const config = makeConfig({ provider: "local", model: "llama3", baseUrl: "" });
    createModel(config);
    expect(createOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: "http://fallback:1234/v1",
      })
    );
    delete process.env.MIZUMI_BASE_URL;
  });

  it("local provider uses default Ollama URL when no baseUrl config or env", () => {
    delete process.env.MIZUMI_BASE_URL;
    const config = makeConfig({ provider: "local", model: "llama3", baseUrl: "" });
    createModel(config);
    expect(createOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: "http://localhost:11434/v1",
      })
    );
  });
});

describe("createModel API key handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes requireApiKey result as apiKey for anthropic", () => {
    vi.mocked(requireApiKey).mockReturnValue("sk-ant-test123");
    const config = makeConfig({ provider: "anthropic", model: "claude-sonnet-4-6" });
    createModel(config);
    expect(createAnthropic).toHaveBeenCalledWith({ apiKey: "sk-ant-test123" });
  });

  it("passes requireApiKey result as apiKey for openai", () => {
    vi.mocked(requireApiKey).mockReturnValue("sk-openai-test456");
    const config = makeConfig({ provider: "openai", model: "gpt-4.1" });
    createModel(config);
    expect(createOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "sk-openai-test456" })
    );
  });

  it("passes requireApiKey result as apiKey for google", () => {
    vi.mocked(requireApiKey).mockReturnValue("google-key-789");
    const config = makeConfig({ provider: "google", model: "gemini-2.5-flash" });
    createModel(config);
    expect(createGoogleGenerativeAI).toHaveBeenCalledWith({ apiKey: "google-key-789" });
  });

  it("calls requireApiKey with correct provider string for each provider", () => {
    const providers = ["anthropic", "openai", "google", "openrouter", "nvidia", "local"] as const;
    for (const provider of providers) {
      vi.mocked(requireApiKey).mockClear();
      const config = makeConfig({ provider, model: "test" });
      try { createModel(config); } catch { /* custom throws */ }
      expect(requireApiKey).toHaveBeenCalledWith(provider);
    }
  });
});

describe("createModel model name passthrough", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireApiKey).mockReturnValue("test-api-key");
  });

  it("anthropic passes model name directly", () => {
    const config = makeConfig({ provider: "anthropic", model: "claude-opus-4-7" });
    createModel(config);
    const factoryFn = vi.mocked(createAnthropic).mock.results[0].value;
    expect(factoryFn).toHaveBeenCalledWith("claude-opus-4-7");
  });

  it("openai passes model name directly", () => {
    const config = makeConfig({ provider: "openai", model: "gpt-4.1-mini" });
    createModel(config);
    const instance = vi.mocked(createOpenAI).mock.results[0].value;
    expect(instance).toHaveBeenCalledWith("gpt-4.1-mini");
  });

  it("google passes model name directly", () => {
    const config = makeConfig({ provider: "google", model: "gemini-2.5-pro" });
    createModel(config);
    const factoryFn = vi.mocked(createGoogleGenerativeAI).mock.results[0].value;
    expect(factoryFn).toHaveBeenCalledWith("gemini-2.5-pro");
  });

  it("openrouter passes model name to .chat()", () => {
    const config = makeConfig({ provider: "openrouter", model: "google/gemini-2.5-flash" });
    createModel(config);
    const instance = vi.mocked(createOpenAI).mock.results[0].value;
    expect(instance.chat).toHaveBeenCalledWith("google/gemini-2.5-flash");
  });

  it("nvidia passes model name to .chat()", () => {
    const config = makeConfig({ provider: "nvidia", model: "nvidia/llama-3.1-nemotron-70b-instruct" });
    createModel(config);
    const instance = vi.mocked(createOpenAI).mock.results[0].value;
    expect(instance.chat).toHaveBeenCalledWith("nvidia/llama-3.1-nemotron-70b-instruct");
  });

  it("custom passes model name to .chat()", () => {
    process.env.CUSTOM_BASE_URL = "https://api.test.com/v1";
    const config = makeConfig({ provider: "custom", model: "my-fine-tuned-model" });
    createModel(config);
    const instance = vi.mocked(createOpenAI).mock.results[0].value;
    expect(instance.chat).toHaveBeenCalledWith("my-fine-tuned-model");
    delete process.env.CUSTOM_BASE_URL;
  });
});

describe("createModel provider name property", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireApiKey).mockReturnValue("test-api-key");
  });

  it("openrouter sets name='openrouter'", () => {
    const config = makeConfig({ provider: "openrouter", model: "test" });
    createModel(config);
    expect(createOpenAI).toHaveBeenCalledWith(expect.objectContaining({ name: "openrouter" }));
  });

  it("local sets name='local'", () => {
    const config = makeConfig({ provider: "local", model: "test" });
    createModel(config);
    expect(createOpenAI).toHaveBeenCalledWith(expect.objectContaining({ name: "local" }));
  });

  it("nvidia sets name='nvidia'", () => {
    const config = makeConfig({ provider: "nvidia", model: "test" });
    createModel(config);
    expect(createOpenAI).toHaveBeenCalledWith(expect.objectContaining({ name: "nvidia" }));
  });

  it("custom sets name='custom'", () => {
    process.env.CUSTOM_BASE_URL = "https://api.test.com/v1";
    const config = makeConfig({ provider: "custom", model: "test" });
    createModel(config);
    expect(createOpenAI).toHaveBeenCalledWith(expect.objectContaining({ name: "custom" }));
    delete process.env.CUSTOM_BASE_URL;
  });

  it("openai does NOT set name property (uses default)", () => {
    const config = makeConfig({ provider: "openai", model: "gpt-4.1" });
    createModel(config);
    const call = vi.mocked(createOpenAI).mock.calls[0][0] as any;
    expect(call.name).toBeUndefined();
  });
});
