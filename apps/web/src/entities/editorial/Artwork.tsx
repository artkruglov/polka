import React from 'react';

// Editorial illustrations, not screenshots or representations of live data.
const editions: Record<string, {name:string; caption:string; tone:string; motif:string}> = {
  'decision-matrix':{name:'Искусство\nвыбирать',caption:'Сравнивайте. Решайте.',tone:'night',motif:'matrix'},
  'probability-lab':{name:'Случайность\nпод контролем',caption:'Лаборатория вероятностей',tone:'blue',motif:'dots'},
  'tile-pattern':{name:'Ритм\nи повторение',caption:'Геометрия простых вещей',tone:'peach',motif:'tiles'},
  'reading-session':{name:'Время\nдля чтения',caption:'Один текст. Один вопрос.',tone:'paper',motif:'pages'},
  'sorting-explainer':{name:'Из хаоса\nв порядок',caption:'Алгоритмы становятся видимыми',tone:'night',motif:'bars'},
  'meal-plan':{name:'Неделя\nна столе',caption:'Маленький план на каждый день',tone:'green',motif:'matrix'},
  'contrast-explorer':{name:'Почувствуйте\nразницу',caption:'Цвет. Свет. Контраст.',tone:'blue',motif:'dots'},
  'packing-checklist':{name:'Всё нужное\nс собой',caption:'Собираемся на прогулку',tone:'peach',motif:'pages'},
  'data-literacy':{name:'За средним —\nцелая история',caption:'Посмотрите на данные иначе',tone:'paper',motif:'bars'},
  'week-allocation':{name:'168 часов.\nВаша неделя.',caption:'Время в наглядных пропорциях',tone:'blue',motif:'bars'},
  'city-observation':{name:'Город\nв деталях',caption:'Учимся замечать',tone:'night',motif:'city'},
  'fractions':{name:'Часть\nцелого',caption:'Доли без зубрёжки',tone:'green',motif:'dots'},
};
export function EditorialArtwork({slug}:{slug:string}) {
 const e=editions[slug]; if(!e) return null;
 return <div className={`editorial-art art-${e.tone}`} aria-hidden="true">
  <span className="art-edition">ПОЛКА / ИНТЕРАКТИВНАЯ КОЛЛЕКЦИЯ</span>
  <strong>{e.name.split('\n').map((s,i)=><React.Fragment key={s}>{i>0&&<br/>}{s}</React.Fragment>)}</strong>
  <span className="art-caption">{e.caption}</span>
  <svg viewBox="0 0 480 320" preserveAspectRatio="xMidYMid slice">
   {e.motif==='dots'&&Array.from({length:21},(_,i)=><circle key={i} cx={265+i%5*40} cy={75+Math.floor(i/5)*45} r={14+i%3*3} fill="currentColor" opacity={.25+(i%4)*.2}/>)}
   {e.motif==='matrix'&&Array.from({length:16},(_,i)=><rect key={i} x={255+i%4*48} y={77+Math.floor(i/4)*48} width="36" height="36" rx="7" fill="currentColor" opacity={.12+(i%5)*.18} transform="rotate(-12 345 165)"/>)}
   {e.motif==='tiles'&&Array.from({length:20},(_,i)=><path key={i} d={`M ${240+i%4*55} ${40+Math.floor(i/4)*55} h 50 v 50 a 50 50 0 0 1 -50 -50`} fill="currentColor" opacity={.2+(i%3)*.3}/>)}
   {e.motif==='bars'&&[70,130,95,185,155,230].map((h,i)=><rect key={i} x={247+i*35} y={285-h} width="25" height={h} rx="6" fill="currentColor" opacity={.22+i*.13}/>)}
   {e.motif==='pages'&&[0,1,2].map(i=><g key={i} transform={`translate(${240+i*24},${90+i*15}) rotate(${i*9-12})`}><rect width="140" height="190" rx="6" fill="currentColor" opacity={.25+i*.22}/><path d="M20 36h95M20 56h95M20 76h65" stroke="var(--art-bg)" strokeWidth="5"/></g>)}
   {e.motif==='city'&&[130,210,170,250,110].map((h,i)=><g key={i}><rect x={245+i*44} y={300-h} width="34" height={h} fill="currentColor" opacity={.3+i*.12}/>{[0,1,2,3].map(j=><path key={j} d={`M${253+i*44} ${310-h+j*23}h17`} stroke="var(--art-bg)" strokeWidth="5"/>)}</g>)}
  </svg>
 </div>;
}
