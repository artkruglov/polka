import { Templates } from '../../pages/templates/index.tsx';
import { Signup } from '../../pages/signup/index.tsx';
import { FirstSave } from '../../pages/start/index.tsx';
import { AgentConnections } from '../../pages/agents/index.tsx';
import React from 'react';
import { App } from '../workspace/index.tsx';
import { Recipient } from '../../pages/recipient/index.tsx';
import { Bring } from '../../pages/bring/index.tsx';
import { NewLanding } from '../../pages/landing/index.tsx';
import { EditorialPage } from '../../pages/discover/index.tsx';
import { LibraryInvite } from '../../pages/library-invite/index.tsx';

// The development inventory never enters the production bundle.
const ComponentCatalog = import.meta.env.DEV
  ? React.lazy(() => import('../../pages/component-catalog/index.tsx').then(module => ({default:module.ComponentCatalog})))
  : null;
export function AppRoutes({path=location.pathname}:{path?:string}){
 if(path==='/dev/components'&&ComponentCatalog)return <React.Suspense fallback={<p role="status">Загружаем компоненты…</p>}><ComponentCatalog/></React.Suspense>;
 if(path==='/templates')return <Templates/>;
 if(path==='/library-invite')return <LibraryInvite/>;
 if(path==='/signup')return <Signup/>;
 if(path==='/start')return <FirstSave/>;
 if(path==='/settings/agents'||path==='/connections')return <AgentConnections/>;
 if(path==='/s')return <Recipient/>;
 if(path==='/landing')return <NewLanding/>;
 if(path.startsWith('/discover'))return <EditorialPage/>;
 if(path.startsWith('/bring'))return <Bring/>;
 return <App/>;
}
