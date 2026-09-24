// The slice of the Chrome extension API this extension uses. Written by hand
// to avoid a dependency on @types/chrome; shapes follow
// https://developer.chrome.com/docs/extensions/reference/api.

declare namespace chrome {
  namespace runtime {
    const id: string;
    const lastError: { message?: string } | undefined;
    type MessageSender = {
      id?: string;
      tab?: tabs.Tab;
      frameId?: number;
      url?: string;
      origin?: string;
    };
    function getManifest(): { version: string; name: string };
    function getURL(path: string): string;
    function sendMessage<T = unknown>(message: unknown): Promise<T>;
    function openOptionsPage(): Promise<void>;
    const onMessage: {
      addListener(
        callback: (
          message: any,
          sender: MessageSender,
          sendResponse: (response?: unknown) => void,
        ) => boolean | void,
      ): void;
    };
    const onInstalled: { addListener(callback: () => void): void };
    const onStartup: { addListener(callback: () => void): void };
  }

  namespace storage {
    type StorageArea = {
      get(keys: string | string[] | null): Promise<Record<string, any>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
    };
    const local: StorageArea;
    const session: StorageArea & {
      setAccessLevel(options: {
        accessLevel: "TRUSTED_CONTEXTS" | "TRUSTED_AND_UNTRUSTED_CONTEXTS";
      }): Promise<void>;
    };
    const onChanged: {
      addListener(
        callback: (
          changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
          area: string,
        ) => void,
      ): void;
    };
  }

  namespace tabs {
    type Tab = {
      id?: number;
      url?: string;
      title?: string;
      status?: "loading" | "complete" | "unloaded";
      active: boolean;
      windowId: number;
    };
    function query(query: {
      active?: boolean;
      currentWindow?: boolean;
    }): Promise<Tab[]>;
    function get(tabId: number): Promise<Tab>;
    function create(properties: {
      url: string;
      active?: boolean;
      openerTabId?: number;
    }): Promise<Tab>;
    function remove(tabId: number): Promise<void>;
    function sendMessage(
      tabId: number,
      message: unknown,
      options?: { frameId?: number },
    ): Promise<unknown>;
    const onUpdated: {
      addListener(
        callback: (tabId: number, info: { status?: string; url?: string }, tab: Tab) => void,
      ): void;
      removeListener(callback: (...args: any[]) => void): void;
    };
    const onRemoved: {
      addListener(callback: (tabId: number) => void): void;
      removeListener(callback: (...args: any[]) => void): void;
    };
  }

  namespace scripting {
    type InjectionTarget = {
      tabId: number;
      frameIds?: number[];
      allFrames?: boolean;
    };
    type InjectionResult<T> = { frameId: number; result?: T };
    function executeScript<T = unknown>(injection: {
      target: InjectionTarget;
      files?: string[];
      func?: (...args: any[]) => T | Promise<T>;
      args?: unknown[];
      world?: "ISOLATED" | "MAIN";
      injectImmediately?: boolean;
    }): Promise<InjectionResult<Awaited<T>>[]>;
    type RegisteredContentScript = {
      id: string;
      matches: string[];
      js: string[];
      runAt?: "document_start" | "document_end" | "document_idle";
      allFrames?: boolean;
      persistAcrossSessions?: boolean;
    };
    function registerContentScripts(
      scripts: RegisteredContentScript[],
    ): Promise<void>;
    function unregisterContentScripts(filter?: { ids?: string[] }): Promise<void>;
    function getRegisteredContentScripts(filter?: {
      ids?: string[];
    }): Promise<RegisteredContentScript[]>;
  }

  namespace identity {
    function getRedirectURL(path?: string): string;
    function launchWebAuthFlow(details: {
      url: string;
      interactive: boolean;
    }): Promise<string | undefined>;
  }

  namespace permissions {
    function contains(permissions: { origins?: string[] }): Promise<boolean>;
    function request(permissions: { origins?: string[] }): Promise<boolean>;
  }

  namespace action {
    function setBadgeText(details: { text: string; tabId?: number }): Promise<void>;
  }
}
