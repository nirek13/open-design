import { useEffect } from 'react';
import { APP_BRIDGE_PROTOCOL, type AppBridgeResponse, type AppDataScope } from '@open-design/contracts';
import {
  isAppBridgeRequest,
  performAppBridgeRequest,
  replyAppBridge,
} from './app-bridge-host';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Answer `window.od` calls from a sandboxed preview iframe. */
export function useAppSdkHost(options: {
  orgId: string | null;
  scopes: readonly AppDataScope[] | 'preview';
  isSource: (source: MessageEventSource | null) => boolean;
}): void {
  const { orgId, scopes, isSource } = options;

  useEffect(() => {
    if (!orgId) return;

    const onMessage = (event: MessageEvent) => {
      if (!isSource(event.source)) return;
      if (!isAppBridgeRequest(event.data)) return;
      const request = event.data;
      const target = event.source as Window;
      void (async () => {
        const reply = (response: AppBridgeResponse) => replyAppBridge(target, response);
        try {
          const result = await performAppBridgeRequest(orgId, request, scopes);
          reply({ protocol: APP_BRIDGE_PROTOCOL, id: request.id, ok: true, result });
        } catch (err) {
          reply({
            protocol: APP_BRIDGE_PROTOCOL,
            id: request.id,
            ok: false,
            error: errorMessage(err),
          });
        }
      })();
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [isSource, orgId, scopes]);
}
