// `/slack` is the Slack-shaped workspace chat for organization teammates.
// Messages live in the org database (team chat), not in Slack.com.

import { TeamChatView } from '../team/TeamChatView';

interface Props {
  active: boolean;
  initialChannelId?: string;
}

export function SlackView({ active, initialChannelId }: Props) {
  return <TeamChatView active={active} initialChannelId={initialChannelId} homeView="slack" />;
}
