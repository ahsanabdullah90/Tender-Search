import { useEffect, useState } from 'react';
import { Tabs } from '../ui';
import { DataTab } from './sources/DataTab';
import { KeywordsTab } from './sources/KeywordsTab';
import { PortalsTab } from './sources/PortalsTab';
import type { SourcesScreenProps, SourcesTab } from './sources/shared';

export function SourcesScreen(props: SourcesScreenProps) {
  const [tab, setTab] = useState<SourcesTab>(props.initialTab || 'keywords');

  useEffect(() => {
    if (props.initialTab) {
      setTab(props.initialTab);
    }
  }, [props.initialTab]);

  return (
    <div className="mx-auto w-full max-w-4xl space-y-5 p-6">
      <h1 className="text-xl font-bold">Sources & Keywords</h1>
      <Tabs
        label="Sources and keywords"
        value={tab}
        onChange={setTab}
        items={[
          { id: 'keywords', label: 'Keywords', count: props.tracks.length },
          { id: 'portals', label: 'Portals', count: props.portals.length },
          { id: 'data', label: 'Data' },
        ]}
      />
      {tab === 'keywords' && <KeywordsTab tracks={props.tracks} onSaveTrack={props.onSaveTrack} onDeleteTrack={props.onDeleteTrack} />}
      {tab === 'portals' && (
        <PortalsTab
          portals={props.portals}
          onUpdatePortal={props.onUpdatePortal}
          onAddPortal={props.onAddPortal}
          onDeletePortal={props.onDeletePortal}
          onLaunchHitl={props.onLaunchHitl}
          onVerifyHitl={props.onVerifyHitl}
          onScanSinglePortal={props.onScanSinglePortal}
        />
      )}
      {tab === 'data' && <DataTab onClearInbox={props.onClearInbox} onEraseAll={props.onEraseAll} />}
    </div>
  );
}
