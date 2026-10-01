const ALERT_PROXY_URL = window.BESPEKA_ALERT_PROXY_URL || './alert-status.json';
const API_BASE = ALERT_PROXY_URL.replace(/\/status(?:\?.*)?$/, '');
const SHELTERS_URL = API_BASE.startsWith('http') ? API_BASE + '/shelters' : './shelters.json';
const ALERTS_URL = API_BASE.startsWith('http') ? API_BASE + '/alerts' : './alert-status.json';
const UKRAINE_GEOJSON = 'https://cdn.jsdelivr.net/gh/darmat1/ukraine-geo-data@main/geodata/Ukraine.geojson';
const KYIV_RAIONS_GEOJSON = 'https://cdn.jsdelivr.net/gh/darmat1/ukraine-geo-data@main/geodata/kyyivska_oblast.geojson';
const CACHE_KEY = 'bespeka-shelters-v8';
const FAV_KEY = 'bespeka-favorites-v1';

const $ = id => document.getElementById(id);
const favorites = new Set(JSON.parse(localStorage.getItem(FAV_KEY) || '[]'));
let shelters = [], filtered = [], activeFilter = 'all', userPos = null, userMarker = null, nearestShelter = null;
let currentTab = 'map', deferredPrompt = null, alerts = [], alertGeoLayer = null, alertsLoaded = false, alertScope = 'kyiv';

const map = L.map('map', { zoomControl: true }).setView([50.36, 30.43], 9);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
const clusters = L.markerClusterGroup({ showCoverageOnHover: false, maxClusterRadius: 46 });
map.addLayer(clusters);

const alertsMap = L.map('alertsMap', { zoomControl: true, attributionControl: false }).setView([48.8, 31.2], 5);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 12, attribution: '© OpenStreetMap' }).addTo(alertsMap);

function esc(v=''){return String(v).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
function norm(s=''){return String(s).toLowerCase().normalize('NFKD').replace(/[’'"]/g,'')}
function saveFavs(){localStorage.setItem(FAV_KEY,JSON.stringify([...favorites]))}
function distance(a,b){const R=6371,dLat=(b.lat-a.lat)*Math.PI/180,dLon=(b.lng-a.lng)*Math.PI/180;const x=Math.sin(dLat/2)**2+Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dLon/2)**2;return 2*R*Math.asin(Math.sqrt(x))}
function formatDist(km){return km<1?Math.round(km*1000)+' м':(km<10?km.toFixed(1):Math.round(km))+' км'}
function formatTime(v){if(!v)return'';try{return new Date(v).toLocaleTimeString('uk-UA',{hour:'2-digit',minute:'2-digit'})}catch{return''}}
function markerIcon(source){return L.divIcon({className:'',html:`<div class="marker-dot ${source==='kyiv_official'?'marker-official':'marker-osm'}"></div>`,iconSize:[17,17],iconAnchor:[8,8]})}
async function fetchJson(url, timeout=65000){const c=new AbortController(),t=setTimeout(()=>c.abort(),timeout);try{const r=await fetch(url,{signal:c.signal,cache:'no-store'});if(!r.ok)throw new Error(String(r.status));return await r.json()}finally{clearTimeout(t)}}

function sourceLabel(s){return s.source==='kyiv_official'?'КМДА · офіційні дані':'ДСНС · офіційний реєстр'}
function typeLabel(s){return s.type==='simple'?'Найпростіше укриття':'Укриття / сховище'}

function applyFilter(){
  listLimit = 250;
  const q=norm($('search').value.trim());
  filtered=shelters.filter(s=>{
    if(activeFilter==='oblast'&&s.source!=='dsns')return false;
    if(activeFilter==='kyiv'&&s.source!=='kyiv_official')return false;
    if(activeFilter==='accessible'&&!s.accessible)return false;
    if(activeFilter==='favorites'&&!favorites.has(s.id))return false;
    if(q&&!norm([s.name,s.address,s.city,s.district,s.community].join(' ')).includes(q))return false;
    return true;
  });
  renderShelterMap();
  renderShelterList();
  updateNearest();
}

function renderShelterMap(){
  clusters.clearLayers();
  for(const s of filtered){
    const m=L.marker([s.lat,s.lng],{icon:markerIcon(s.source)});
    m.on('click',()=>openShelter(s));
    clusters.addLayer(m);
  }
}

function renderShelterList(){
  const list=[...filtered];
  if(userPos) list.sort((a,b)=>distance(userPos,a)-distance(userPos,b));
  else list.sort((a,b)=>(a.city||a.address||'').localeCompare(b.city||b.address||'','uk'));
  $('listCount').textContent=list.length+' укриттів';
  $('listHint').textContent=userPos?'За відстанню від вас':'Київ та Київська область';

  $('shelterList').innerHTML=list.map(s=>{
    const d=userPos?`<span class="distance">${formatDist(distance(userPos,s))}</span>`:'';
    const fav=favorites.has(s.id)?'★ ':'';
    return `<button class="list-item" data-id="${esc(s.id)}">
      <div class="list-item-top">
        <span class="list-pin">⌖</span>
        <span class="list-main"><b>${fav}${esc(s.name)}</b><small>${esc(s.address)}${s.district?' · '+esc(s.district):''}</small></span>
        ${d}
      </div>
      <div class="mini-tags"><span class="mini-tag ${s.source==='kyiv_official'?'official':''}">${s.source==='kyiv_official'?'Київ · КМДА':'Область · ДСНС'}</span>${s.accessible?'<span class="mini-tag">♿ доступність</span>':''}</div>
    </button>`;
  }).join('') || '<div class="empty-state">За цим пошуком нічого не знайдено</div>';

  document.querySelectorAll('.list-item').forEach(el=>el.onclick=()=>{
    const s=shelters.find(x=>x.id===el.dataset.id);
    if(s) openShelter(s);
  });
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
  $('sheetContent').innerHTML=`
    <h2>${esc(s.name)}</h2>
    <div class="meta">${esc(s.address)}${s.district?'<br>'+esc(s.district):''}${s.community?' · '+esc(s.community):''}</div>
    ${photo}
    <div class="badges">
      <span class="badge ${s.source==='kyiv_official'?'green':'blue'}">${esc(sourceLabel(s))}</span>
      <span class="badge">${esc(typeLabel(s))}</span>
      ${s.accessible?'<span class="badge">♿ Доступність позначена</span>':''}
      ${s.hours?`<span class="badge">🕒 ${esc(s.hours)}</span>`:''}
    </div>
    <div class="detail-grid">
      <div class="detail"><span>Відстань</span><b>${dist}</b></div>
      <div class="detail"><span>Місткість</span><b>${esc(s.capacity||'Не вказано')}</b></div>
    </div>
    <div class="actions">
      <a class="action main" href="${route}" target="_blank" rel="noopener">Маршрут</a>
      <a class="action alt" href="${osm}" target="_blank" rel="noopener">OSM</a>
    </div>
    <button id="favToggle" class="fav-btn">${fav?'★ Прибрати з обраного':'☆ Додати в обране'}</button>
    <p class="note">Перед використанням перевір фактичну доступність входу. Джерело точки показано вище.</p>`;
  $('sheet').classList.add('open');
  $('favToggle').onclick=()=>{favorites.has(s.id)?favorites.delete(s.id):favorites.add(s.id);saveFavs();openShelter(s);applyFilter()};
}

function threatLabel(t){
  const map={drones:'БпЛА',drone:'БпЛА',ballistic:'Балістика',ballistics:'Балістика',missiles:'Ракети',missile:'Ракети',aviation:'Авіація',aircraft:'Авіація',rocket:'Ракетна загроза'};
  return map[t]||String(t||'').replaceAll('_',' ');
}
function alertTypeLabel(t){
  return {air_raid:'Повітряна тривога',artillery_shelling:'Артобстріл',urban_fights:'Міські бої',chemical:'Хімічна загроза',nuclear:'Ядерна / радіаційна загроза'}[t]||t||'Тривога';
}
function oblastAlerts(name){
  return alerts.filter(a=>a.location_oblast===name||a.location_title===name);
}
function isKyivOblastAlert(a){
  return a.location_oblast==='Київська область'||a.location_title==='Київська область';
}
function raionAlerts(name){
  return alerts.filter(a=>{
    if(name==='Київ') return a.location_title==='Київ'||a.location_title==='м. Київ'||a.location_oblast==='м. Київ';
    if(!isKyivOblastAlert(a)) return false;
    if(a.location_title==='Київська область') return true;
    return a.location_raion===name||a.location_title===name;
  });
}

function setKyivBanner(data){
  const b=$('alertBanner');
  const active=data.active===true;
  b.className='alert-banner '+(data.active===null||data.active===undefined?'alert-unknown':active?'alert-active':'alert-safe');
  const details=[...(data.alert_types||[]).map(alertTypeLabel),...(data.threats||[]).map(threatLabel)];
  const districts=[...new Set((data.active_locations||[]).map(x=>x.raion).filter(Boolean))];
  $('alertTitle').textContent=active?(details[0]||'Тривога у Київській області'):'Тривоги немає';
  $('alertText').textContent=active?(districts.slice(0,3).join(' · ')||details.slice(1,3).join(' · ')||'Київська область'):'Київська область · '+formatTime(data.updated_at);
}

async function refreshStatus(){
  try{
    const sep=ALERT_PROXY_URL.includes('?')?'&':'?';
    const data=await fetchJson(ALERT_PROXY_URL+sep+'ts='+Date.now(),12000);
    setKyivBanner(data);
  }catch{
    $('alertBanner').className='alert-banner alert-unknown';
    $('alertTitle').textContent='Статус тривоги недоступний';
    $('alertText').textContent='Спробую оновити автоматично';
  }
}

async function loadAlerts(){
  try{
    const data=await fetchJson(ALERTS_URL+'?ts='+Date.now(),15000);
    alerts=Array.isArray(data.alerts)?data.alerts:[];
    $('alertsUpdated').textContent='Оновлено '+formatTime(data.updated_at);
    renderThreats();
    if(!alertsLoaded){await renderAlertMap();alertsLoaded=true}else styleAlertMap();
  }catch{
    $('threatList').innerHTML='<div class="empty-state">Не вдалося оновити карту тривог</div>';
  }
}

function renderThreats(){
  if(alertScope==='kyiv'){
    $('threatsTitle').textContent='Тривоги по районах';
    const raions=['Бучанський район','Фастівський район','Білоцерківський район','Бориспільський район','Броварський район','Вишгородський район','Обухівський район'];
    const groups=raions.map(name=>[name,raionAlerts(name)]).filter(([,items])=>items.length);
    $('activeRegionsCount').textContent=String(groups.length);
    $('threatList').innerHTML=groups.map(([name,items])=>threatCard(name,items)).join('')||
      '<div class="empty-state">У районах Київської області активних тривог зараз немає</div>';
    return;
  }

  $('threatsTitle').textContent='Активні загрози по Україні';
  const oblastMap=new Map();
  for(const a of alerts){
    const key=a.location_oblast||a.location_title||'Інше';
    if(!oblastMap.has(key))oblastMap.set(key,[]);
    oblastMap.get(key).push(a);
  }
  const groups=[...oblastMap.entries()].sort((a,b)=>a[0].localeCompare(b[0],'uk'));
  $('activeRegionsCount').textContent=String(groups.length);
  $('threatList').innerHTML=groups.map(([name,items])=>threatCard(name,items)).join('')||
    '<div class="empty-state">Активних тривог зараз немає</div>';
}

function threatCard(name,items){
  const allThreats=[...new Set(items.flatMap(x=>x.threats||[]).map(x=>x.threat_type).filter(Boolean))];
  const types=[...new Set(items.map(x=>x.alert_type).filter(Boolean))];
  const started=items.map(x=>x.started_at).filter(Boolean).sort()[0];
  const local=items.map(x=>x.location_title).filter(x=>x&&x!==name&&x!=='Київська область');
  return `<div class="threat-card">
    <div class="threat-card-head"><b>${esc(name)}</b><time>${started?'з '+formatTime(started):''}</time></div>
    <p>${esc([...new Set(local)].slice(0,4).join(' · ')||types.map(alertTypeLabel).join(' · '))}</p>
    <div class="threat-chips">${[...types.map(alertTypeLabel),...allThreats.map(threatLabel)].slice(0,5).map(x=>`<span class="threat-chip">${esc(x)}</span>`).join('')}</div>
  </div>`;
}

async function renderAlertMap(){
  if(alertGeoLayer){alertsMap.removeLayer(alertGeoLayer);alertGeoLayer=null}
  const geo=await fetchJson(alertScope==='kyiv'?KYIV_RAIONS_GEOJSON:UKRAINE_GEOJSON,25000);
  alertGeoLayer=L.geoJSON(geo,{
    style:feature=>alertRegionStyle(feature?.properties?.name),
    onEachFeature:(feature,layer)=>{
      const name=feature?.properties?.name||'Регіон';
      layer.on('click',()=>{
        const items=alertScope==='kyiv'?raionAlerts(name):oblastAlerts(name);
        const labels=[...new Set(items.flatMap(x=>[
          alertTypeLabel(x.alert_type),
          ...(x.threats||[]).map(t=>threatLabel(t.threat_type))
        ]).filter(Boolean))];
        const msg=items.length?(labels.join(' · ')||'Активна тривога'):'Активних тривог немає';
        layer.bindPopup(`<b>${esc(name)}</b><br>${esc(msg)}`).openPopup();
      });
    }
  }).addTo(alertsMap);
  try{alertsMap.fitBounds(alertGeoLayer.getBounds(),{padding:[6,6]})}catch{}
}
function alertRegionStyle(name){
  const items=alertScope==='kyiv'?raionAlerts(name):oblastAlerts(name);
  const active=items.length>0;
  const yellow=items.length&&items.every(x=>x.alert_level==='yellow');
  return {
    color:active?(yellow?'#e8bc4f':'#ff5967'):'#52627a',
    weight:alertScope==='kyiv'?1.5:1,
    fillColor:active?(yellow?'#e8bc4f':'#ff5967'):'#18263a',
    fillOpacity:active?.66:.22
  };
}
function styleAlertMap(){if(alertGeoLayer)alertGeoLayer.eachLayer(layer=>layer.setStyle(alertRegionStyle(layer.feature?.properties?.name)))}

async function loadShelters(){
  const cached=JSON.parse(localStorage.getItem(CACHE_KEY)||'null');
  if(cached?.shelters?.length){shelters=cached.shelters;applyFilter();$('dataBadge').textContent=cached.shelters.length+' точок · кеш'}
  try{
    const data=await fetchJson(SHELTERS_URL+'?ts='+Date.now(),65000);
    shelters=Array.isArray(data.shelters)?data.shelters:[];
    localStorage.setItem(CACHE_KEY,JSON.stringify({shelters,updated_at:data.updated_at}));
    applyFilter();
    const a=data.counts?.kyiv_official||0,b=data.counts?.oblast_dsns||data.counts?.dsns||0;
    $('dataBadge').textContent=shelters.length+' точок · Київ '+a+' · область '+b+(data.partial?' · частково':'');
  }catch{
    $('dataBadge').textContent=shelters.length?shelters.length+' точок · офлайн-кеш':'Не вдалося завантажити укриття';
  }
}

function switchTab(tab){
  currentTab=tab;
  document.querySelectorAll('.nav-btn').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));
  $('mapView').classList.toggle('active',tab==='map');
  $('listView').classList.toggle('active',tab==='list');
  $('alertsView').classList.toggle('active',tab==='alerts');
  $('shelterControls').classList.toggle('hidden',tab==='alerts');
  setTimeout(()=>{if(tab==='map')map.invalidateSize();if(tab==='alerts'){alertsMap.invalidateSize();loadAlerts()}},80);
}

document.querySelectorAll('.nav-btn').forEach(b=>b.onclick=()=>switchTab(b.dataset.tab));
document.querySelectorAll('.scope-btn').forEach(b=>b.onclick=async()=>{
  alertScope=b.dataset.alertScope;
  document.querySelectorAll('.scope-btn').forEach(x=>x.classList.toggle('active',x===b));
  renderThreats();
  alertsLoaded=false;
  await renderAlertMap();
  alertsLoaded=true;
});
$('alertBanner').onclick=()=>switchTab('alerts');
$('search').addEventListener('input',applyFilter);
document.querySelectorAll('.chip').forEach(c=>c.onclick=()=>{document.querySelectorAll('.chip').forEach(x=>x.classList.remove('active'));c.classList.add('active');activeFilter=c.dataset.filter;applyFilter()});
$('locateBtn').onclick=()=>{
  if(!navigator.geolocation)return;
  $('dataBadge').textContent='Визначаю місцезнаходження…';
  navigator.geolocation.getCurrentPosition(p=>{
    userPos={lat:p.coords.latitude,lng:p.coords.longitude};
    if(userMarker)map.removeLayer(userMarker);
    userMarker=L.circleMarker([userPos.lat,userPos.lng],{radius:8,color:'#fff',weight:3,fillColor:'#f4c95d',fillOpacity:1}).addTo(map).bindPopup('Ви тут');
    map.setView([userPos.lat,userPos.lng],14);applyFilter();$('dataBadge').textContent=shelters.length+' точок';
  },()=>{$('dataBadge').textContent='Не вдалося визначити геолокацію'},{enableHighAccuracy:true,timeout:12000});
};
$('nearestCard').onclick=()=>{if(nearestShelter){openShelter(nearestShelter);map.setView([nearestShelter.lat,nearestShelter.lng],17)}};
$('closeSheet').onclick=()=> $('sheet').classList.remove('open');
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredPrompt=e;$('installBtn').classList.remove('hidden')});
$('installBtn').onclick=async()=>{if(deferredPrompt){deferredPrompt.prompt();await deferredPrompt.userChoice;deferredPrompt=null;$('installBtn').classList.add('hidden')}};
if('serviceWorker' in navigator)navigator.serviceWorker.register('./sw.js').catch(()=>{});

loadShelters();
refreshStatus();
setInterval(refreshStatus,30000);
setInterval(()=>{if(currentTab==='alerts')loadAlerts()},45000);
