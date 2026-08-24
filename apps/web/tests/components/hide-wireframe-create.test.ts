import { describe, expect, it } from 'vitest';
import type { InstalledPluginRecord } from '@open-design/contracts';
import {
  isHiddenWireframeCreateId,
  isHiddenWireframeCreatePlugin,
  isHiddenWireframeCreateSkill,
} from '../../src/components/plugins-home/curatedPriority';

function plugin(id: string, tags: string[] = []): InstalledPluginRecord {
  return {
    id,
    title: id,
    version: '0.1.0',
    sourceKind: 'bundled',
    source: '/tmp',
    trust: 'bundled',
    capabilitiesGranted: [],
    manifest: {
      name: id,
      version: '0.1.0',
      title: id,
      tags,
    },
    fsPath: '/tmp',
    installedAt: 0,
    updatedAt: 0,
  };
}

describe('hidden wireframe create plugins', () => {
  it('hides bundled wireframe example plugins and design-template ids', () => {
    expect(isHiddenWireframeCreateId('example-wireframe-sketch')).toBe(true);
    expect(isHiddenWireframeCreateId('wireframe-greybox')).toBe(true);
    expect(isHiddenWireframeCreateId('example-open-design-landing')).toBe(false);
  });

  it('hides plugins tagged as wireframe even when the id is generic', () => {
    expect(isHiddenWireframeCreatePlugin(plugin('custom-lofi', ['wireframe']))).toBe(true);
    expect(isHiddenWireframeCreatePlugin(plugin('saas-landing', ['landing']))).toBe(false);
  });

  it('hides design-template skills that declare wireframe fidelity', () => {
    expect(isHiddenWireframeCreateSkill({ id: 'saas-landing', fidelity: 'wireframe' })).toBe(true);
    expect(isHiddenWireframeCreateSkill({ id: 'saas-landing', fidelity: 'high-fidelity' })).toBe(false);
  });
});
