const ALERT_PROXY_URL = window.BESPEKA_ALERT_PROXY_URL || './alert-status.json';
const API_BASE = ALERT_PROXY_URL.replace(/\/status(?:\?.*)?$/, '');
const SHELTERS_URL = API_BASE.startsWith('http') ? API_BASE + '/shelters' : './shelters.json';
const ALERTS_URL = API_BASE.startsWith('http') ? API_BASE + '/alerts' : './alert-status.json';

const UKRAINE_GEOJSON = 'https://cdn.jsdelivr.net/gh/darmat1/ukraine-geo-data@main/geodata/Ukraine.geojson';
const GEO_BASE = 'https://cdn.jsdelivr.net/gh/darmat1/ukraine-geo-data@main/geodata/';
const KYIV_DISTRICTS = [
  {name:'Бучанський район',file:'kyyivska_oblast.buchanskyy_rayon.geojson'},
  {name:'Фастівський район',file:'kyyivska_oblast.fastivskyy_rayon.geojson'},
  {name:'Білоцерківський район',file:'kyyivska_oblast.bilotserkivskyy_rayon.geojson'},
  {name:'Бориспільський район',file:'kyyivska_oblast.boryspilskyy_rayon.geojson'},
  {name:'Броварський район',file:'kyyivska_oblast.brovarskyy_rayon.geojson'},
  {name:'Вишгородський район',file:'kyyivska_oblast.vyshhorodskyy_rayon.geojson'},
  {name:'Обухівський район',file:'kyyivska_oblast.obukhivskyy_rayon.geojson'}
];

const CACHE_KEY='bespeka-shelters-v10';
const FAV_KEY='bespeka-favorites-v1';
const MAP_STYLE_KEY='bespeka-map-style-v1';
const ALERT_OVERLAY_KEY='bespeka-alert-overlay-v1';
const $=id=>document.getElementById(id);

let shelters=[],filtered=[],activeFilter='all',searchQuery='',userPos=null,userMarker=null,nearestShelter=null,listLimit=250;
let alerts=[],alertScope='kyiv',alertMapLayer=null,alertMapLabels=[],alertOverlayLayer=null,alertOverlayLabels=[];
let currentTab='map',deferredPrompt=null;
const favorites=new Set(JSON.parse(localStorage.getItem(FAV_KEY)||'[]'));

const baseLayers={
  clean:L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',{
    maxZoom:16,attribution:'Tiles © Esri'
  }),
  standard:L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',{
    maxZoom:19,attribution:'Tiles © Esri'
  }),
  satellite:L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',{
    maxZoom:19,attribution:'Tiles © Esri'
  })
};
let mapStyle=localStorage.getItem(MAP_STYLE_KEY)||'clean';
let alertOverlayEnabled=localStorage.getItem(ALERT_OVERLAY_KEY)==='1';

const map=L.map('map',{zoomControl:true,preferCanvas:true}).setView([50.35,30.42],9);
(baseLayers[mapStyle]||baseLayers.clean).addTo(map);
const clusters=L.markerClusterGroup({showCoverageOnHover:false,maxClusterRadius:44,spiderfyOnMaxZoom:true});
map.addLayer(clusters);

const alertsMap=L.map('alertsMap',{zoomControl:false,attributionControl:false,preferCanvas:true,minZoom:4,maxZoom:11}).setView([48.8,31.2],5);

function esc(v=''){return String(v).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
function norm(v=''){return String(v).toLowerCase().normalize('NFKD').replace(/[’'"]/g,'')}
function saveFavs(){localStorage.setItem(FAV_KEY,JSON.stringify([...favorites]))}
function formatTime(v){if(!v)return'';try{return new Date(v).toLocaleTimeString('uk-UA',{hour:'2-digit',minute:'2-digit'})}catch{return''}}
function distance(a,b){const R=6371,dLat=(b.lat-a.lat)*Math.PI/180,dLon=(b.lng-a.lng)*Math.PI/180;const q=Math.sin(dLat/2)**2+Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dLon/2)**2;return 2*R*Math.asin(Math.sqrt(q))}
function formatDist(km){return km<1?Math.round(km*1000)+' м':(km<10?km.toFixed(1):Math.round(km))+' км'}
function markerIcon(s){return L.divIcon({className:'',html:`<div class="marker-dot ${s.source==='kyiv_official'?'marker-official':'marker-dsns'}"></div>`,iconSize:[16,16],iconAnchor:[8,8]})}
async function fetchJson(url,timeout=65000){const ctl=new AbortController(),t=setTimeout(()=>ctl.abort(),timeout);try{const r=await fetch(url,{signal:ctl.signal,cache:'no-store'});if(!r.ok)throw new Error('HTTP '+r.status);return await r.json()}finally{clearTimeout(t)}}

function sourceLabel(s){return s.source==='kyiv_official'?'КМДА · офіційно':'ДСНС · офіційно'}
function typeLabel(s){return s.type==='simple'?'Найпростіше укриття':'Укриття / сховище'}
function isKyivOblastAlert(a){return a.location_oblast==='Київська область'||a.location_title==='Київська область'}
function oblastAlerts(name){return alerts.filter(a=>a.location_oblast===name||a.location_title===name)}
function districtAlerts(name){
  return alerts.filter(a=>{
    if(!isKyivOblastAlert(a))return false;
    if(a.location_title==='Київська область')return true;
    return a.location_raion===name||a.location_title===name;
  });
}
function threatLabel(t){
  const k=norm(t).replaceAll(' ','_');
  const dict={
    drones:'БпЛА',drone:'БпЛА',uav:'БпЛА',shahed:'БпЛА',
    ballistic:'Балістика',ballistics:'Балістика',ballistic_missiles:'Балістика',
    missiles:'Ракети',missile:'Ракети',rocket:'Ракети',cruise_missiles:'Крилаті ракети',
    aviation:'Авіація',aircraft:'Авіація',guided_bombs:'КАБ',
    artillery:'Артилерія',artillery_shelling:'Артобстріл'
  };
  return dict[k]||String(t||'Загроза').replaceAll('_',' ');
}
function alertTypeLabel(t){
  return {
    air_raid:'Повітряна тривога',
    artillery_shelling:'Артобстріл',
    urban_fights:'Міські бої',
    chemical:'Хімічна загроза',
    nuclear:'Ядерна / радіаційна загроза'
  }[t]||t||'Тривога';
}
function alertColor(items){
  if(!items.length)return'safe';
  return items.some(x=>x.alert_level==='red')?'red':items.some(x=>x.alert_level==='yellow')?'yellow':'red';
}
function isFullAreaAlert(name,items,scope){
  if(!items.length)return false;
  if(scope==='kyiv')return items.some(a=>a.location_title==='Київська область'||a.location_title===name);
  return items.some(a=>a.location_title===name);
}

function setSearch(v){
  searchQuery=v;
  if($('mapSearch').value!==v)$('mapSearch').value=v;
  if($('listSearch').value!==v)$('listSearch').value=v;
  applyFilter(false);
}
function setFilter(f){
  activeFilter=f;
  document.querySelectorAll('[data-filter]').forEach(b=>b.classList.toggle('active',b.dataset.filter===f));
  applyFilter(false);
}
function applyFilter(resetLimit=true){
  if(resetLimit)listLimit=250;
  const q=norm(searchQuery.trim());
  filtered=shelters.filter(s=>{
    if(activeFilter==='oblast'&&s.source!=='dsns')return false;
    if(activeFilter==='kyiv'&&s.source!=='kyiv_official')return false;
    if(activeFilter==='accessible'&&!s.accessible)return false;
    if(activeFilter==='favorites'&&!favorites.has(s.id))return false;
    if(q&&!norm([s.name,s.address,s.city,s.district,s.community,s.registry_number].filter(Boolean).join(' ')).includes(q))return false;
    return true;
  });
  renderShelterMap();
  renderShelterList();
  updateNearest();
}

function renderShelterMap(){
  clusters.clearLayers();
  for(const s of filtered){
    const m=L.marker([s.lat,s.lng],{icon:markerIcon(s)});
    m.on('click',()=>openShelter(s));
    clusters.addLayer(m);
  }
}
function renderShelterList(){
  const list=[...filtered];
  if(userPos)list.sort((a,b)=>distance(userPos,a)-distance(userPos,b));
  else list.sort((a,b)=>(a.city||a.address||'').localeCompare(b.city||b.address||'','uk'));

  $('listCount').textContent=String(list.length);
  $('listSubtitle').textContent=userPos?'Відсортовано за відстанню':'Київ та Київська область';
  const shown=list.slice(0,listLimit);
  $('shelterList').innerHTML=shown.map(s=>{
    const dist=userPos?`<span class="row-distance">${formatDist(distance(userPos,s))}</span>`:'';
    const fav=favorites.has(s.id)?'★ ':'';
    return `<button class="shelter-row" data-id="${esc(s.id)}">
      <span class="row-pin">⌖</span>
      <span class="row-main">
        <b>${fav}${esc(s.name)}</b>
        <small>${esc(s.address)}${s.district?' · '+esc(s.district):''}</small>
        <span class="row-meta">
          <span class="row-tag ${s.source==='kyiv_official'?'official':''}">${s.source==='kyiv_official'?'Київ · КМДА':'Область · ДСНС'}</span>
          ${s.accessible?'<span class="row-tag">♿ доступне</span>':''}
          ${s.capacity?'<span class="row-tag">'+esc(s.capacity)+' місць</span>':''}
        </span>
      </span>
      ${dist}
    </button>`;
  }).join('')||'<div class="empty-state">Нічого не знайдено</div>';

  if(list.length>shown.length)$('shelterList').insertAdjacentHTML('beforeend',`<button id="loadMore" class="load-more">Показати ще · ${list.length-shown.length}</button>`);
  document.querySelectorAll('.shelter-row').forEach(el=>el.onclick=()=>{const s=shelters.find(x=>x.id===el.dataset.id);if(s)openShelter(s)});
  const more=$('loadMore');if(more)more.onclick=()=>{listLimit+=250;renderShelterList()};
}
function updateNearest(){
  if(!userPos||!shelters.length){$('nearestCard').classList.add('hidden');return}
  nearestShelter=[...shelters].sort((a,b)=>distance(userPos,a)-distance(userPos,b))[0];
  $('nearestName').textContent=nearestShelter.name;
  $('nearestMeta').textContent=formatDist(distance(userPos,nearestShelter))+' · '+nearestShelter.address;
  $('nearestCard').classList.remove('hidden');
}

function openShelter(s){
  const dist=userPos?formatDist(distance(userPos,s)):'—';
  const route=`https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}`;
  const osm=`https://www.openstreetmap.org/?mlat=${s.lat}&mlon=${s.lng}#map=18/${s.lat}/${s.lng}`;
  const photo=s.photo?`<img class="photo" src="${esc(s.photo)}" alt="Фото укриття" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`:'';
  const fav=favorites.has(s.id);
  $('detailsContent').innerHTML=`
    <h2>${esc(s.name)}</h2>
    <div class="meta">${esc(s.address)}${s.district?'<br>'+esc(s.district):''}${s.community?' · '+esc(s.community):''}</div>
    ${photo}
    <div class="badges">
      <span class="badge ${s.source==='kyiv_official'?'green':'blue'}">${esc(sourceLabel(s))}</span>
      <span class="badge">${esc(typeLabel(s))}</span>
      ${s.readiness?'<span class="badge">'+esc(s.readiness)+'</span>':''}
      ${s.accessible?'<span class="badge">♿ доступність</span>':''}
    </div>
    <div class="detail-grid">
      <div class="detail"><span>Відстань</span><b>${dist}</b></div>
      <div class="detail"><span>Місткість</span><b>${esc(s.capacity||'Не вказано')}</b></div>
    </div>
    <div class="actions">
      <a class="action main" href="${route}" target="_blank" rel="noopener">Прокласти маршрут</a>
      <a class="action alt" href="${osm}" target="_blank" rel="noopener">OSM</a>
    </div>
    <button id="favToggle" class="fav-btn">${fav?'★ Прибрати з обраного':'☆ Додати в обране'}</button>
    <p class="note">Перевір фактичну доступність входу перед використанням. Дані показуються з офіційного джерела.</p>`;
  $('detailsSheet').classList.add('open');
  $('favToggle').onclick=()=>{favorites.has(s.id)?favorites.delete(s.id):favorites.add(s.id);saveFavs();openShelter(s);applyFilter(false)};
}

function setMapStyle(style){
  if(!baseLayers[style])return;
  Object.values(baseLayers).forEach(l=>{if(map.hasLayer(l))map.removeLayer(l)});
  baseLayers[style].addTo(map);
  baseLayers[style].bringToBack();
  mapStyle=style;localStorage.setItem(MAP_STYLE_KEY,style);
  document.querySelectorAll('.map-style').forEach(b=>b.classList.toggle('active',b.dataset.mapStyle===style));
}
function fitKyiv(){map.fitBounds([[49.0,29.1],[51.7,32.3]],{padding:[20,20]})}

async function loadDistrictFeatures(){
  const chunks=await Promise.all(KYIV_DISTRICTS.map(async d=>{
    const g=await fetchJson(GEO_BASE+d.file,30000);
    return (g.features||[]).map(f=>({...f,properties:{...(f.properties||{}),__district:d.name,__community:f.properties?.name||''}}));
  }));
  return {type:'FeatureCollection',features:chunks.flat()};
}
function clearLabels(target){
  target.forEach(m=>{try{m.remove()}catch{}});
  target.length=0;
}
function addDistrictLabels(layer,target,mapTarget){
  const byDistrict=new Map();
  layer.eachLayer(l=>{
    const d=l.feature?.properties?.__district;if(!d)return;
    if(!byDistrict.has(d))byDistrict.set(d,L.latLngBounds([]));
    try{byDistrict.get(d).extend(l.getBounds())}catch{}
  });
  for(const [name,bounds] of byDistrict){
    if(!bounds.isValid())continue;
    const m=L.marker(bounds.getCenter(),{interactive:false,icon:L.divIcon({className:'district-label',html:esc(name.replace(' район','')),iconSize:null})}).addTo(mapTarget);
    target.push(m);
  }
}

function alertStyleFor(name,scope){
  const items=scope==='kyiv'?districtAlerts(name):oblastAlerts(name);
  if(!items.length)return{color:'#34465d',weight:1,fillColor:'#172333',fillOpacity:.76};
  const level=alertColor(items),full=isFullAreaAlert(name,items,scope);
  const color=level==='yellow'?'#f2c94c':'#ff5968';
  return{color,weight:scope==='kyiv'?1.2:1.4,fillColor:color,fillOpacity:full?.73:.48,dashArray:full?null:'5 4'};
}
function alertLabels(items){
  return [...new Set(items.flatMap(x=>[
    alertTypeLabel(x.alert_type),
    ...(x.threats||[]).map(t=>threatLabel(t.threat_type))
  ]).filter(Boolean))];
}

async function renderAlertMap(){
  if(alertMapLayer){alertsMap.removeLayer(alertMapLayer);alertMapLayer=null}
  clearLabels(alertMapLabels);

  const geo=alertScope==='kyiv'?await loadDistrictFeatures():await fetchJson(UKRAINE_GEOJSON,30000);
  alertMapLayer=L.geoJSON(geo,{
    style:f=>alertStyleFor(alertScope==='kyiv'?f.properties?.__district:f.properties?.name,alertScope),
    onEachFeature:(f,l)=>{
      const name=alertScope==='kyiv'?(f.properties?.__district||'Район'):(f.properties?.name||'Регіон');
      const community=alertScope==='kyiv'?(f.properties?.__community||''):'';
      l.on('click',()=>{
        const items=alertScope==='kyiv'?districtAlerts(name):oblastAlerts(name);
        const labels=alertLabels(items);
        const text=items.length?(labels.join(' · ')||'Активна тривога'):'Тривоги немає';
        const sub=community&&community!==name?'<br><small>'+esc(community)+'</small>':'';
        l.bindPopup('<b>'+esc(name)+'</b>'+sub+'<br>'+esc(text)).openPopup();
      });
    }
  }).addTo(alertsMap);

  if(alertScope==='kyiv')addDistrictLabels(alertMapLayer,alertMapLabels,alertsMap);
  else{
    alertMapLayer.eachLayer(l=>{
      try{
        const name=l.feature?.properties?.name||'';
        const center=l.getBounds().getCenter();
        const m=L.marker(center,{interactive:false,icon:L.divIcon({className:'region-label',html:esc(name.replace(' область','')),iconSize:null})}).addTo(alertsMap);
        alertMapLabels.push(m);
      }catch{}
    });
  }
  try{alertsMap.fitBounds(alertMapLayer.getBounds(),{padding:[8,8]})}catch{}
}
function restyleAlertMap(){
  if(!alertMapLayer)return;
  alertMapLayer.eachLayer(l=>{
    const name=alertScope==='kyiv'?l.feature?.properties?.__district:l.feature?.properties?.name;
    l.setStyle(alertStyleFor(name,alertScope));
  });
}

async function ensureAlertOverlay(){
  if(alertOverlayLayer)return;
  const geo=await loadDistrictFeatures();
  alertOverlayLayer=L.geoJSON(geo,{
    interactive:false,
    style:f=>{
      const name=f.properties?.__district;
      const items=districtAlerts(name);
      if(!items.length)return{opacity:0,fillOpacity:0};
      const level=alertColor(items),full=isFullAreaAlert(name,items,'kyiv'),color=level==='yellow'?'#f2c94c':'#ff5968';
      return{color,weight:1.3,fillColor:color,fillOpacity:full?.19:.12,dashArray:full?null:'5 4'};
    }
  });
}
async function syncAlertOverlay(){
  if(!alertOverlayEnabled){
    if(alertOverlayLayer&&map.hasLayer(alertOverlayLayer))map.removeLayer(alertOverlayLayer);
    return;
  }
  await ensureAlertOverlay();
  alertOverlayLayer.eachLayer(l=>{
    const name=l.feature?.properties?.__district,items=districtAlerts(name);
    if(!items.length)l.setStyle({opacity:0,fillOpacity:0});
    else{
      const level=alertColor(items),full=isFullAreaAlert(name,items,'kyiv'),color=level==='yellow'?'#f2c94c':'#ff5968';
      l.setStyle({opacity:1,color,weight:1.3,fillColor:color,fillOpacity:full?.19:.12,dashArray:full?null:'5 4'});
    }
  });
  if(!map.hasLayer(alertOverlayLayer))alertOverlayLayer.addTo(map);
}

function renderThreats(){
  if(alertScope==='kyiv'){
    $('threatsTitle').textContent='Райони Київщини';
    const groups=KYIV_DISTRICTS.map(d=>[d.name,districtAlerts(d.name)]);
    const active=groups.filter(([,items])=>items.length).length;
    $('activeRegionsCount').textContent=String(active);
    $('alertsSummary').textContent=active?active+' з 7 районів з активною загрозою':'У всіх районах спокійно';
    $('threatList').innerHTML=groups.map(([name,items])=>threatRow(name,items,true)).join('');
    return;
  }
  $('threatsTitle').textContent='Україна';
  const groups=new Map();
  for(const a of alerts){
    const k=a.location_oblast||a.location_title||'Інше';
    if(!groups.has(k))groups.set(k,[]);
    groups.get(k).push(a);
  }
  const list=[...groups.entries()].sort((a,b)=>a[0].localeCompare(b[0],'uk'));
  $('activeRegionsCount').textContent=String(list.length);
  $('alertsSummary').textContent=list.length?list.length+' регіонів з активною загрозою':'Активних тривог немає';
  $('threatList').innerHTML=list.map(([name,items])=>threatRow(name,items,false)).join('')||'<div class="empty-state">Активних тривог немає</div>';
}
function threatRow(name,items,showSafe){
  if(!items.length&&showSafe)return`<div class="threat-row"><i class="status-dot safe"></i><div class="threat-main"><b>${esc(name)}</b><small>Тривоги немає</small></div></div>`;
  const level=alertColor(items),started=items.map(x=>x.started_at).filter(Boolean).sort()[0];
  const labels=alertLabels(items).slice(0,4);
  const places=[...new Set(items.map(x=>x.location_title).filter(x=>x&&x!==name&&x!=='Київська область'))].slice(0,4);
  return`<div class="threat-row">
    <i class="status-dot ${level}"></i>
    <div class="threat-main">
      <b>${esc(name)}</b>
      <small>${esc(places.join(' · ')||(started?'Від '+formatTime(started):'Активна загроза'))}</small>
      <span class="threat-tags">${labels.map(x=>`<span class="threat-tag ${level==='yellow'?'yellow':''}">${esc(x)}</span>`).join('')}</span>
    </div>
  </div>`;
}

function setAlertPill(data){
  const active=data.active===true;
  $('alertPill').className='alert-pill '+(data.active===null||data.active===undefined?'state-unknown':active?'state-active':'state-safe');
  const labels=[...(data.alert_types||[]).map(alertTypeLabel),...(data.threats||[]).map(threatLabel)];
  const districts=[...new Set((data.active_locations||[]).map(x=>x.raion).filter(Boolean))];
  $('alertPillTitle').textContent=active?(labels[0]||'Тривога на Київщині'):'Тривоги немає';
  $('alertPillText').textContent=active?(districts.slice(0,2).join(' · ')||labels.slice(1,3).join(' · ')||'Київська область'):'Київська область · '+formatTime(data.updated_at);
}
async function refreshStatus(){
  try{
    const sep=ALERT_PROXY_URL.includes('?')?'&':'?';
    const data=await fetchJson(ALERT_PROXY_URL+sep+'ts='+Date.now(),12000);
    setAlertPill(data);
  }catch{
    $('alertPill').className='alert-pill state-unknown';
    $('alertPillTitle').textContent='Статус недоступний';
    $('alertPillText').textContent='Оновлю автоматично';
  }
}
async function loadAlerts(){
  try{
    const data=await fetchJson(ALERTS_URL+'?ts='+Date.now(),15000);
    alerts=Array.isArray(data.alerts)?data.alerts:[];
    $('alertsUpdated').textContent='Оновлено '+formatTime(data.updated_at);
    renderThreats();
    if(alertMapLayer)restyleAlertMap();else await renderAlertMap();
    await syncAlertOverlay();
  }catch{
    $('alertsUpdated').textContent='Помилка оновлення';
  }
}

async function loadShelters(){
  try{
    const cached=JSON.parse(localStorage.getItem(CACHE_KEY)||'null');
    if(cached?.shelters?.length){
      shelters=cached.shelters;applyFilter(false);
      $('dataBadge').textContent=cached.shelters.length+' точок · кеш';
    }
  }catch{}
  try{
    const data=await fetchJson(SHELTERS_URL+'?ts='+Date.now(),65000);
    shelters=Array.isArray(data.shelters)?data.shelters:[];
    localStorage.setItem(CACHE_KEY,JSON.stringify({shelters,updated_at:data.updated_at}));
    applyFilter(false);
    const city=data.counts?.kyiv_official||0,oblast=data.counts?.oblast_dsns||data.counts?.dsns||0;
    $('dataBadge').textContent=shelters.length+' · Київ '+city+' · область '+oblast+(data.partial?' · частково':'');
  }catch{
    $('dataBadge').textContent=shelters.length?shelters.length+' точок · офлайн':'Не вдалося завантажити укриття';
  }
}

function switchTab(tab){
  currentTab=tab;
  document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));
  $('mapView').classList.toggle('active',tab==='map');
  $('listView').classList.toggle('active',tab==='list');
  $('alertsView').classList.toggle('active',tab==='alerts');
  setTimeout(()=>{
    if(tab==='map')map.invalidateSize();
    if(tab==='alerts'){alertsMap.invalidateSize();loadAlerts()}
  },60);
}

$('mapSearch').addEventListener('input',e=>setSearch(e.target.value));
$('listSearch').addEventListener('input',e=>setSearch(e.target.value));
document.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>setFilter(b.dataset.filter));
document.querySelectorAll('.tab').forEach(b=>b.onclick=()=>switchTab(b.dataset.tab));
$('alertPill').onclick=()=>switchTab('alerts');

document.querySelectorAll('.scope-btn').forEach(b=>b.onclick=async()=>{
  alertScope=b.dataset.alertScope;
  document.querySelectorAll('.scope-btn').forEach(x=>x.classList.toggle('active',x===b));
  renderThreats();
  await renderAlertMap();
});

$('locateBtn').onclick=()=>{
  if(!navigator.geolocation)return;
  $('dataBadge').textContent='Визначаю геопозицію…';
  navigator.geolocation.getCurrentPosition(p=>{
    userPos={lat:p.coords.latitude,lng:p.coords.longitude};
    if(userMarker)map.removeLayer(userMarker);
    userMarker=L.circleMarker([userPos.lat,userPos.lng],{radius:7,color:'#fff',weight:3,fillColor:'#f2c94c',fillOpacity:1}).addTo(map).bindPopup('Ви тут');
    map.setView([userPos.lat,userPos.lng],14);
    applyFilter(false);
    $('dataBadge').textContent=shelters.length+' укриттів';
  },()=>{$('dataBadge').textContent='Геопозицію не отримано'},{enableHighAccuracy:true,timeout:12000});
};
$('fitBtn').onclick=fitKyiv;
$('nearestCard').onclick=()=>{if(nearestShelter){openShelter(nearestShelter);map.setView([nearestShelter.lat,nearestShelter.lng],17)}};

$('layersBtn').onclick=()=>$('layersSheet').classList.add('open');
$('closeLayers').onclick=()=>$('layersSheet').classList.remove('open');
$('closeDetails').onclick=()=>$('detailsSheet').classList.remove('open');
document.querySelectorAll('.map-style').forEach(b=>b.onclick=()=>setMapStyle(b.dataset.mapStyle));
$('alertsOverlayToggle').onclick=async()=>{
  alertOverlayEnabled=!alertOverlayEnabled;
  localStorage.setItem(ALERT_OVERLAY_KEY,alertOverlayEnabled?'1':'0');
  $('alertsOverlayToggle').classList.toggle('on',alertOverlayEnabled);
  $('alertsOverlayToggle').setAttribute('aria-pressed',String(alertOverlayEnabled));
  if(alertOverlayEnabled&&!alerts.length)await loadAlerts();
  await syncAlertOverlay();
};

window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredPrompt=e});
if('serviceWorker' in navigator)navigator.serviceWorker.register('./sw.js').catch(()=>{});

setMapStyle(mapStyle);
$('alertsOverlayToggle').classList.toggle('on',alertOverlayEnabled);
$('alertsOverlayToggle').setAttribute('aria-pressed',String(alertOverlayEnabled));
loadShelters();
refreshStatus();
loadAlerts();
setInterval(refreshStatus,30000);
setInterval(loadAlerts,45000);
