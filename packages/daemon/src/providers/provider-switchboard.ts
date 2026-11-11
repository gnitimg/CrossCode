import * as fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { HarnessId } from '@crosscode/shared';

/**
 * Provider routing switchboard ("保险箱").
 *
 * Owns the catalog of model providers (built-in + custom OpenAI-compatible
 * endpoints), resolves the environment variable map a harness needs to talk
 * to a provider (with global < harness < project override priority), and
 * persists the active provider per project in
 * `<project>/.agent/runtime/provider-state.json`.
 *
 * Credential values are NEVER hard-coded here: they are read from an
 * injectable credential source (a function or a plain record), so tests can
 * inject fake keys without touching real environment secrets.
 */

export type ProviderProtocol = 'anthropic' | 'openai' | 'gemini' | 'custom';

export interface ProviderApiKeyEnvSpec {
  /** Target environment variable, e.g. `ANTHROPIC_API_KEY`. */
  name: string;
  /** Key looked up in the injectable credential source (defaults to `name`). */
  credentialKey?: string;
  /**
   * Additional environment variables the same credential value is mirrored
   * to. Used to expose OpenAI-compatible endpoints under `OPENAI_API_KEY`.
   */
  aliases?: string[];
}

export interface ProviderBaseUrlEnvSpec {
  /** Target environment variable, e.g. `ANTHROPIC_BASE_URL`. */
  name: string;
  /** Same-value aliases, e.g. `OPENAI_BASE_URL` for OpenAI-compatible relays. */
  aliases?: string[];
}

export interface ProviderDefinition {
  id: string;
  label: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  models: string[];
  /** API key injection spec; omitted for providers that need no key (ollama). */
  apiKeyEnv?: ProviderApiKeyEnvSpec;
  /** Base URL injection spec. */
  baseUrlEnv?: ProviderBaseUrlEnvSpec;
  /** True for providers registered at runtime via {@link registerCustomProvider}. */
  isCustom?: boolean;
}

/** Client-safe catalog entry (contains no credential material). */
export interface ProviderCatalogEntry {
  id: string;
  label: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  models: string[];
  requiredEnvVars: string[];
  baseUrlEnvVars: string[];
  isCustom: boolean;
}

export type CredentialSource = (credentialKey: string) => string | undefined;

export interface ProviderSwitchboardOptions {
  /**
   * Injected credential values. Either a lookup function or a plain record.
   * Defaults to reading `process.env` — tests must inject fake keys instead.
   */
  credentials?: CredentialSource | Record<string, string>;
  /** Extra providers added on top of the built-in catalog. */
  providers?: ProviderDefinition[];
  /**
   * Where per-project runtime state is stored. Defaults to
   * `<projectPath>/.agent/runtime`; injectable for tests.
   */
  runtimeDir?: (projectPath: string) => string;
  /** Provider assumed when a project has no persisted state. */
  defaultProviderId?: string;
}

export interface ResolveEnvOptions {
  /** Provider to resolve; defaults to the active provider of `projectPath`. */
  providerId?: string;
  /** Project whose active provider is used when `providerId` is omitted. */
  projectPath?: string;
  /** Harness the env map is being injected into (context metadata). */
  harnessId?: HarnessId;
  /**
   * Environment overrides merged with priority **global < harness < project**
   * (later levels win). Keys are environment variable names.
   */
  overrides?: {
    global?: Record<string, string>;
    harness?: Record<string, string>;
    project?: Record<string, string>;
  };
}

export interface ProviderRuntimeState {
  providerId: string;
  updatedAt: string;
}

const DEFAULT_PROVIDER_ID = 'deepseek';

function buildBuiltinProviders(): ProviderDefinition[] {
  return [
    {
      id: 'anthropic',
      label: 'Anthropic (Claude)',
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      models: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'],
      apiKeyEnv: { name: 'ANTHROPIC_API_KEY' },
      baseUrlEnv: { name: 'ANTHROPIC_BASE_URL' },
    },
    {
      id: 'openai',
      label: 'OpenAI',
      protocol: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      models: ['gpt-4.1', 'gpt-4o', 'o3'],
      apiKeyEnv: { name: 'OPENAI_API_KEY' },
      baseUrlEnv: { name: 'OPENAI_BASE_URL' },
    },
    {
      id: 'deepseek',
      label: 'DeepSeek',
      // DeepSeek speaks the OpenAI chat-completions protocol, so the key and
      // base URL are also mirrored to the OPENAI_* aliases for harnesses that
      // only implement the OpenAI-compatible endpoint form.
      protocol: 'openai',
      baseUrl: 'https://api.deepseek.com',
      models: ['deepseek-chat', 'deepseek-reasoner'],
      apiKeyEnv: { name: 'DEEPSEEK_API_KEY', aliases: ['OPENAI_API_KEY'] },
      baseUrlEnv: { name: 'DEEPSEEK_BASE_URL', aliases: ['OPENAI_BASE_URL'] },
    },
    {
      id: 'gemini',
      label: 'Google Gemini',
      protocol: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com',
      models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
      apiKeyEnv: { name: 'GEMINI_API_KEY' },
      baseUrlEnv: { name: 'GEMINI_BASE_URL' },
    },
    {
      id: 'openrouter',
      label: 'OpenRouter',
      protocol: 'openai',
      baseUrl: 'https://openrouter.ai/api/v1',
      models: ['openrouter/auto', 'anthropic/claude-sonnet-4.5', 'deepseek/deepseek-chat'],
      apiKeyEnv: { name: 'OPENROUTER_API_KEY', aliases: ['OPENAI_API_KEY'] },
      baseUrlEnv: { name: 'OPENROUTER_BASE_URL', aliases: ['OPENAI_BASE_URL'] },
    },
    {
      id: 'ollama',
      label: 'Ollama (local)',
      protocol: 'openai',
      baseUrl: 'http://127.0.0.1:11434/v1',
      models: ['qwen3-coder', 'llama3.1', 'deepseek-r1'],
      // Local Ollama needs no API key; only the base URL is injected.
      baseUrlEnv: { name: 'OLLAMA_BASE_URL', aliases: ['OPENAI_BASE_URL'] },
    },
  ];
}

export class ProviderSwitchboard {
  private readonly providers = new Map<string, ProviderDefinition>();
  private readonly credentialSource: CredentialSource;
  private readonly runtimeDirResolver: (projectPath: string) => string;
  private readonly defaultProviderId: string;

  constructor(options: ProviderSwitchboardOptions = {}) {
    for (const provider of buildBuiltinProviders()) {
      this.providers.set(provider.id, provider);
    }
    for (const provider of options.providers ?? []) {
      this.providers.set(provider.id, provider);
    }

    const credentials = options.credentials;
    this.credentialSource =
      typeof credentials === 'function'
        ? credentials
        : credentials
          ? (key) => credentials[key]
          : (key) => process.env[key];

    this.runtimeDirResolver =
      options.runtimeDir ?? ((projectPath) => path.join(path.resolve(projectPath), '.agent', 'runtime'));
    this.defaultProviderId = options.defaultProviderId ?? DEFAULT_PROVIDER_ID;
  }

  // ---------------------------------------------------------------------------
  // Catalog
  // ---------------------------------------------------------------------------

  listProviders(): ProviderCatalogEntry[] {
    return Array.from(this.providers.values())
      .map((provider) => toCatalogEntry(provider))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  getProvider(providerId: string): ProviderDefinition | undefined {
    return this.providers.get(providerId);
  }

  /**
   * Registers a custom OpenAI-compatible provider (user-supplied baseURL).
   * The API key is injected under the given env var (default `OPENAI_API_KEY`)
   * and the endpoint under `OPENAI_BASE_URL`, so any OpenAI-protocol harness
   * can consume it without code changes.
   */
  registerCustomProvider(input: {
    id?: string;
    label: string;
    baseUrl: string;
    models?: string[];
    apiKeyEnvName?: string;
  }): ProviderDefinition {
    if (!input.baseUrl || typeof input.baseUrl !== 'string') {
      throw new Error('Custom provider requires a baseUrl');
    }
    const id =
      input.id ??
      `custom-${slugify(input.label) || randomSlug()}`;
    if (this.providers.has(id)) {
      throw new Error(`Provider '${id}' is already registered`);
    }
    const apiKeyEnvName = input.apiKeyEnvName ?? 'OPENAI_API_KEY';
    const definition: ProviderDefinition = {
      id,
      label: input.label,
      protocol: 'custom',
      baseUrl: input.baseUrl,
      models: input.models ?? [],
      // Mirror the key under OPENAI_API_KEY (unless it already is that var)
      // so OpenAI-protocol harnesses can consume the endpoint as-is.
      apiKeyEnv: {
        name: apiKeyEnvName,
        aliases: apiKeyEnvName === 'OPENAI_API_KEY' ? [] : ['OPENAI_API_KEY'],
      },
      baseUrlEnv: { name: 'OPENAI_BASE_URL' },
      isCustom: true,
    };
    this.providers.set(id, definition);
    return definition;
  }

  // ---------------------------------------------------------------------------
  // Environment resolution
  // ---------------------------------------------------------------------------

  /**
   * Builds the environment variable map to inject into a harness for the
   * requested provider. Priority: base provider spec, then overrides merged
   * as **global < harness < project** (later levels win).
   */
  resolveEnv(options: ResolveEnvOptions = {}): Record<string, string> {
    const providerId =
      options.providerId ??
      (options.projectPath ? this.getActiveProviderId(options.projectPath) : this.defaultProviderId);
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new Error(`Unknown provider '${providerId}'`);
    }

    const env: Record<string, string> = {};

    if (provider.apiKeyEnv) {
      const credentialKey = provider.apiKeyEnv.credentialKey ?? provider.apiKeyEnv.name;
      const value = this.credentialSource(credentialKey) ?? this.credentialSource(provider.apiKeyEnv.name);
      if (value !== undefined && value.length > 0) {
        env[provider.apiKeyEnv.name] = value;
        for (const alias of provider.apiKeyEnv.aliases ?? []) {
          env[alias] = value;
        }
      }
    }

    if (provider.baseUrlEnv) {
      env[provider.baseUrlEnv.name] = provider.baseUrl;
      for (const alias of provider.baseUrlEnv.aliases ?? []) {
        env[alias] = provider.baseUrl;
      }
    }

    // Context metadata for harnesses (best-effort, never secret).
    env['CROSSCODE_PROVIDER_ID'] = provider.id;
    env['CROSSCODE_PROVIDER_PROTOCOL'] = provider.protocol;
    env['CROSSCODE_PROVIDER_BASE_URL'] = provider.baseUrl;
    if (options.harnessId) {
      env['CROSSCODE_HARNESS_ID'] = options.harnessId;
    }

    // Priority: global < harness < project.
    Object.assign(env, options.overrides?.global ?? {});
    Object.assign(env, options.overrides?.harness ?? {});
    Object.assign(env, options.overrides?.project ?? {});

    return env;
  }

  // ---------------------------------------------------------------------------
  // Per-project active provider persistence
  // ---------------------------------------------------------------------------

  /** Persists the active provider for a project in its runtime directory. */
  async switchProvider(
    projectPath: string,
    providerId: string,
    options: { modelId?: string } = {},
  ): Promise<ProviderRuntimeState> {
    if (!this.providers.has(providerId)) {
      throw new Error(`Unknown provider '${providerId}'`);
    }
    const dir = this.runtimeDirResolver(projectPath);
    await fs.mkdir(dir, { recursive: true });
    const state: ProviderRuntimeState = {
      providerId,
      updatedAt: new Date().toISOString(),
    };
    const statePath = path.join(dir, 'provider-state.json');
    await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    if (options.modelId !== undefined) {
      await fs.writeFile(
        path.join(dir, 'model-state.json'),
        `${JSON.stringify({ modelId: options.modelId, updatedAt: state.updatedAt }, null, 2)}\n`,
        'utf8',
      );
    }
    return state;
  }

  /** Returns the persisted active provider id, or the default when unset. */
  getActiveProviderId(projectPath: string): string {
    const statePath = path.join(this.runtimeDirResolver(projectPath), 'provider-state.json');
    try {
      // State files are tiny JSON documents; synchronous read keeps this
      // usable from sync call sites. Missing/malformed state → default.
      const parsed = JSON.parse(readFileSync(statePath, 'utf8')) as ProviderRuntimeState;
      if (typeof parsed.providerId === 'string' && this.providers.has(parsed.providerId)) {
        return parsed.providerId;
      }
    } catch {
      // missing or malformed state → fall through to default
    }
    return this.defaultProviderId;
  }

  /** Convenience: the full active provider definition for a project. */
  getActiveProvider(projectPath: string): ProviderDefinition {
    const providerId = this.getActiveProviderId(projectPath);
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new Error(`Unknown provider '${providerId}'`);
    }
    return provider;
  }
}

function toCatalogEntry(provider: ProviderDefinition): ProviderCatalogEntry {
  return {
    id: provider.id,
    label: provider.label,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    models: [...provider.models],
    requiredEnvVars: provider.apiKeyEnv ? [provider.apiKeyEnv.name, ...(provider.apiKeyEnv.aliases ?? [])] : [],
    baseUrlEnvVars: provider.baseUrlEnv ? [provider.baseUrlEnv.name, ...(provider.baseUrlEnv.aliases ?? [])] : [],
    isCustom: provider.isCustom === true,
  };
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function randomSlug(): string {
  return Math.random().toString(36).slice(2, 8);
}
