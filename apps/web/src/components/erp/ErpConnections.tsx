// ERP no longer owns its own connector catalog. Connecting accounts happens
// once on Connect; this module only deep-links there if something still
// mounts the old connections view.

import { useEffect } from 'react';
import { navigate } from '../../router';

interface Props {
  active: boolean;
}

export function ErpConnections({ active }: Props) {
  useEffect(() => {
    if (!active) return;
    navigate({ kind: 'home', view: 'integrations' });
  }, [active]);
  return null;
}
