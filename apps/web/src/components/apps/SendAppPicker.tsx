'use client';

import type { OrgApp } from '@open-design/contracts';
import { sendAppToChat } from './sendAppToChat';
import { SendToChatPicker, type SendToChatPickerProps } from './SendToChatPicker';

export interface SendAppPickerProps extends Omit<SendToChatPickerProps, 'name' | 'onSend'> {
  app: Pick<OrgApp, 'id' | 'name' | 'accessMode'>;
}

export function SendAppPicker({
  orgId,
  app,
  ...rest
}: SendAppPickerProps) {
  return (
    <SendToChatPicker
      orgId={orgId}
      name={app.name}
      onSend={(destinations, body, except) => sendAppToChat(orgId, app, destinations, body, except)}
      {...rest}
    />
  );
}
