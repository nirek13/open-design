import type { EntryHomeView } from '../../router';

/** Places Spotlight can open. Labels come from the same nav copy as the dock. */
export const SPOTLIGHT_DESTINATIONS: ReadonlyArray<{
  id: string;
  view: EntryHomeView;
  labelKey:
    | 'entry.navWorkspace'
    | 'entry.navSearch'
    | 'entry.navPages'
    | 'entry.navTeam'
    | 'entry.navMail'
    | 'entry.navCalendar'
    | 'entry.navSlack'
    | 'entry.navProjects'
    | 'entry.navApps'
    | 'entry.navPlugins'
    | 'entry.navDesignSystems'
    | 'entry.navLibrary'
    | 'entry.navTasks'
    | 'entry.navDatabase'
    | 'entry.navIntegrations'
    | 'entry.navOrganization'
    | 'entry.navTables'
    | 'entry.navDev';
  aliases: readonly string[];
}> = [
  { id: 'home', view: 'workspace', labelKey: 'entry.navWorkspace', aliases: ['workspace', 'home', 'hub'] },
  { id: 'search', view: 'search', labelKey: 'entry.navSearch', aliases: ['search', 'spotlight', 'find'] },
  { id: 'pages', view: 'pages', labelKey: 'entry.navPages', aliases: ['pages', 'wiki', 'docs'] },
  { id: 'team', view: 'team', labelKey: 'entry.navTeam', aliases: ['team', 'chat'] },
  { id: 'mail', view: 'mail', labelKey: 'entry.navMail', aliases: ['mail', 'gmail', 'inbox', 'email'] },
  { id: 'calendar', view: 'calendar', labelKey: 'entry.navCalendar', aliases: ['calendar', 'events'] },
  { id: 'slack', view: 'slack', labelKey: 'entry.navSlack', aliases: ['slack'] },
  { id: 'projects', view: 'projects', labelKey: 'entry.navProjects', aliases: ['projects', 'designs'] },
  { id: 'apps', view: 'apps', labelKey: 'entry.navApps', aliases: ['apps'] },
  { id: 'plugins', view: 'plugins', labelKey: 'entry.navPlugins', aliases: ['plugins'] },
  { id: 'design-systems', view: 'design-systems', labelKey: 'entry.navDesignSystems', aliases: ['design systems', 'brands'] },
  { id: 'library', view: 'library', labelKey: 'entry.navLibrary', aliases: ['assets', 'library', 'upload'] },
  { id: 'tasks', view: 'tasks', labelKey: 'entry.navTasks', aliases: ['automations', 'tasks'] },
  { id: 'database', view: 'database', labelKey: 'entry.navDatabase', aliases: ['database'] },
  { id: 'integrations', view: 'integrations', labelKey: 'entry.navIntegrations', aliases: ['connect', 'integrations', 'accounts'] },
  { id: 'organization', view: 'organization', labelKey: 'entry.navOrganization', aliases: ['people', 'members', 'team'] },
  { id: 'tables', view: 'tables', labelKey: 'entry.navTables', aliases: ['tables', 'spreadsheet', 'grid'] },
  { id: 'dev', view: 'dev', labelKey: 'entry.navDev', aliases: ['dev', 'github'] },
];

export function matchesSpotlightQuery(haystack: string, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return haystack.toLowerCase().includes(needle);
}
