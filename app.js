const KYIV_API = 'https://gisserver.kyivcity.gov.ua/mayno/rest/services/KYIV_API/Public_protection/MapServer/0/query?where=1%3D1&outFields=*&returnGeometry=true&f=geojson&outSR=4326';
const OVERPASS = 'https://overpass-api.de/api/interpreter';
const OSM_AREA = 3600071248;
const CACHE_KEY = 'bespeka-shelters-v4';
const FAV_KEY = 'bespeka-favorites-v1';

const ALERT_CONFIG = window.BESPEKA_ALERT_API || null;

const map = L.map('map',{zoomControl:true}).setView([50.36,30.43],9);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap contributors'}).addTo(map);
const clusters = L.markerClusterGroup({showCoverageOnHover:false,maxClusterRadius:48});
map.addLayer(clusters);

let shelters=[], filtered=[], userPos=null, userMarker=null, deferredPrompt=null, activeFilter='all', nearestShelter=null;
const favorites = new Set(JSON.parse(localStorage.getItem(FAV_KEY)||'[]'));
const els = id => document.getElementById(id);

function esc(v=''){return String(v).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
function textProp(p,...keys){for(const k of keys){if(p?.[k]!==undefined&&p[k]!==null&&String(p[k]).trim()) return String(p[k]).trim()}return ''}
function norm(s=''){return s.toLowerCase().normalize('NFKD').replace(/[’'"]/g,'')}
function classify(p,source){const raw=norm([p.type_building,p.type,p.shelter_type,p.description,p.name].filter(Boolean).join(' '));if(raw.includes('найпрост')||raw.includes('simple'))return'simple';if(raw.includes('сховищ')||raw.includes('bomb')||raw.includes('shelter'))return'shelter';return source==='official'?'shelter':'simple'}
function isAccessible(p){const raw=norm([p.disabled,p.accessibility,p.wheelchair,p.invalid,p.mgn].filter(Boolean).join(' '));return ['yes','так','true','доступ'].some(x=>raw.includes(x))}
function hoursOf(p){return textProp(p,'opening_hours','work_time','working_hours','hours')}
function openLabel(p){const h=hoursOf(p);if(!h)return 'Невідомо';if(/24\/7|цілодоб/i.test(h))return '24/7';return h}
function photoUrl(p){const direct=textProp(p,'image','photo','image_url');if(/^https?:\/\//i.test(direct))return direct;const commons=textProp(p,'wikimedia_commons');if(commons){const name=commons.replace(/^File:/i,'').trim();if(name)return'https://commons.wikimedia.org/wiki/Special:Redirect/file/'+encodeURIComponent(name)}return''}
function addressOf(p){const full=textProp(p,'address','full_address','adress','addr');if(full)return full;const street=textProp(p,'addr:street','street','street_name');const house=textProp(p,'addr:housenumber','house','building_num');const city=textProp(p,'addr:city','city','settlement');return [city,[street,house].filter(Boolean).join(', ')].filter(Boolean).join(', ')||'Адресу не вказано'}
function nameOf(p,type){return textProp(p,'name','title','type_building')||(type==='simple'?'Найпростіше укриття':'Укриття')}
function toPoint(feature,source){if(!feature?.geometry||feature.geometry.type!=='Point')return null;const [lng,lat]=feature.geometry.coordinates;if(!Number.isFinite(lat)||!Number.isFinite(lng))return null;const p=feature.properties||{},type=classify(p,source);return{id:source+':' +(feature.id||p.id||p.objectid||lat+','+lng),lat,lng,source,type,accessible:isAccessible(p),name:nameOf(p,type),address:addressOf(p),photo:photoUrl(p),hours:openLabel(p),props:p}}
function osmElementToPoint(e){const lat=e.lat??e.center?.lat,lng=e.lon??e.center?.lon;if(!Number.isFinite(lat)||!Number.isFinite(lng))return null;const p=e.tags||{},type=classify(p,'osm');return{id:'osm:'+e.type+':'+e.id,lat,lng,source:'osm',type,accessible:isAccessible(p),name:nameOf(p,type),address:addressOf(p),photo:photoUrl(p),hours:openLabel(p),props:p}}
async function fetchJson(url,opts={},timeout=18000){const ctl=new AbortController(),t=setTimeout(()=>ctl.abort(),timeout);try{const r=await fetch(url,{...opts,signal:ctl.signal});if(!r.ok)throw new Error(r.status);return await r.json()}finally{clearTimeout(t)}}
async function loadOfficial(){const gj=await fetchJson(KYIV_API);return(gj.features||[]).map(f=>toPoint(f,'official')).filter(Boolean)}
async function loadOsm(){const q=`[out:json][timeout:30];area(${OSM_AREA})->.a;(nwr["amenity"="shelter"](area.a);nwr["shelter_type"](area.a);nwr["emergency"="shelter"](area.a);nwr["military"="bunker"]["bunker_type"="civil_defense"](area.a););out center tags;`;const j=await fetchJson(OVERPASS,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8'},body:'data='+encodeURIComponent(q)},35000);return(j.elements||[]).map(osmElementToPoint).filter(Boolean)}
function dedupe(items){const out=[],seen=new Set();for(const s of items){const key=Math.round(s.lat*10000)+'|'+Math.round(s.lng*10000);if(seen.has(key))continue;seen.add(key);out.push(s)}return out}
function saveCache(items){try{localStorage.setItem(CACHE_KEY,JSON.stringify({t:Date.now(),items}))}catch{}}
function readCache(){try{return JSON.parse(localStorage.getItem(CACHE_KEY)||'null')}catch{return null}}
function saveFavs(){localStorage.setItem(FAV_KEY,JSON.stringify([...favorites]))}
function markerIcon(source){return L.divIcon({className:'',html:`<div class="marker-dot ${source==='official'?'marker-official':'marker-osm'}"></div>`,iconSize:[18,18],iconAnchor:[9,9]})}
function distance(a,b){const R=6371,dLat=(b.lat-a.lat)*Math.PI/180,dLon=(b.lng-a.lng)*Math.PI/180;const x=Math.sin(dLat/2)**2+Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dLon/2)**2;return 2*R*Math.asin(Math.sqrt(x))}
function formatDist(km){return km<1?Math.round(km*1000)+' м':(km<10?km.toFixed(1):Math.round(km))+' км'}

function updateNearest(){
  if(!userPos||!shelters.length){els('nearestCard').classList.add('hidden');return}
  nearestShelter=[...shelters].sort((a,b)=>distance(userPos,a)-distance(userPos,b))[0];
  const d=formatDist(distance(userPos,nearestShelter));
  els('nearestName').textContent=nearestShelter.name;
  els('nearestMeta').textContent=d+' · '+nearestShelter.address;
  els('nearestCard').classList.remove('hidden');
}

function render(){
  const q=norm(els('search').value.trim());
  filtered=shelters.filter(s=>{
    if(activeFilter==='official'&&s.source!=='official')return false;
    if(activeFilter==='shelter'&&s.type!=='shelter')return false;
    if(activeFilter==='simple'&&s.type!=='simple')return false;
    if(activeFilter==='accessible'&&!s.accessible)return false;
    if(activeFilter==='favorites'&&!favorites.has(s.id))return false;
    if(q&&!norm(s.name+' '+s.address+' '+JSON.stringify(s.props)).includes(q))return false;
    return true;
  });
  clusters.clearLayers();
  for(const s of filtered){const m=L.marker([s.lat,s.lng],{icon:markerIcon(s.source)});m.on('click',()=>openShelter(s));clusters.addLayer(m)}
  els('countLabel').textContent=filtered.length+' укриттів';renderList();updateNearest();
}

function renderList(){
  const list=[...filtered];if(userPos)list.sort((a,b)=>distance(userPos,a)-distance(userPos,b));
  els('shelterList').innerHTML=list.slice(0,120).map(s=>{
    const d=userPos?'<span class="distance">'+formatDist(distance(userPos,s))+'</span>':'';
    const fav=favorites.has(s.id)?'★ ':'';
    return `<button class="list-item" data-id="${esc(s.id)}">${d}<b>${fav}${esc(s.name)}</b><small>${esc(s.address)} · ${s.source==='official'?'офіційні дані Києва':'OpenStreetMap'}</small></button>`;
  }).join('')||'<p class="legend-note">Нічого не знайдено. Зміни пошук або фільтр.</p>';
  document.querySelectorAll('.list-item').forEach(b=>b.onclick=()=>{const s=shelters.find(x=>x.id===b.dataset.id);if(s){openShelter(s);map.setView([s.lat,s.lng],17);els('listPanel').classList.remove('open')}})
}

function openShelter(s){
  const dist=userPos?formatDist(distance(userPos,s)):'—';
  const source=s.source==='official'?'Офіційні дані Києва':'OpenStreetMap';
  const photo=s.photo?`<img class="photo" src="${esc(s.photo)}" alt="Фото укриття" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`:'';
  const route=`https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}`;
  const osm=`https://www.openstreetmap.org/?mlat=${s.lat}&mlon=${s.lng}#map=18/${s.lat}/${s.lng}`;
  const fav=favorites.has(s.id);
  els('sheetContent').innerHTML=`
    <h2>${esc(s.name)}</h2><div class="meta">${esc(s.address)}</div>
    ${photo}
    <div class="badges">
      <span class="badge ${s.source==='official'?'green':'blue'}">${source}</span>
      <span class="badge">${s.type==='simple'?'Найпростіше укриття':'Укриття / сховище'}</span>
      ${s.accessible?'<span class="badge">♿ Доступність позначена</span>':''}
      <span class="badge warn">🕒 ${esc(s.hours||'Невідомо')}</span>
    </div>
    <div class="detail-grid">
      <div class="detail"><span>Відстань</span><b>${dist}</b></div>
      <div class="detail"><span>Координати</span><b>${s.lat.toFixed(5)}, ${s.lng.toFixed(5)}</b></div>
    </div>
    <div class="actions">
      <a class="action main" href="${route}" target="_blank" rel="noopener">Прокласти маршрут</a>
      <a class="action alt" href="${osm}" target="_blank" rel="noopener">Відкрити на OSM</a>
    </div>
    <button id="favToggle" class="fav-btn">${fav?'★ Прибрати з обраного':'☆ Додати в обране'}</button>
    <p class="legend-note">Перед використанням перевіряй фактичну доступність входу. Дані можуть змінюватися; застосунок показує джерело кожної точки.</p>`;
  els('sheet').classList.add('open');
  els('favToggle').onclick=()=>{if(favorites.has(s.id))favorites.delete(s.id);else favorites.add(s.id);saveFavs();openShelter(s);render()}
}

function setAlertState(active,text='',updatedAt=''){
  const b=els('alertBanner');
  b.className='alert-banner '+(active===true?'alert-active':active===false?'alert-safe':'alert-unknown');
  els('alertTitle').textContent=active===true?'⚠️ ПОВІТРЯНА ТРИВОГА':active===false?'✓ Тривоги немає':'Тривоги';
  const stamp=updatedAt?' · '+new Date(updatedAt).toLocaleTimeString('uk-UA',{hour:'2-digit',minute:'2-digit'}):'';
  els('alertText').textContent=(text||'Статус невідомий')+stamp;
}
async function refreshAlert(){
  try{
    const data=await fetchJson('./alert-status.json?ts='+Date.now(),{},10000);
    setAlertState(data.active===true,data.text||'Київська область',data.updated_at||'');
  }catch{
    setAlertState(null,'Статус тимчасово недоступний');
  }
}

function setStatus(text,cls=''){const e=els('status');e.style.opacity='1';e.textContent=text;e.className='status '+cls;setTimeout(()=>{if(cls==='ok')e.style.opacity='.7'},4000)}
async function loadData(){
  const cache=readCache();if(cache?.items?.length){shelters=cache.items;render();setStatus('Показано кеш · оновлюю дані…')}
  const results=await Promise.allSettled([loadOfficial(),loadOsm()]);
  const fresh=results.flatMap(r=>r.status==='fulfilled'?r.value:[]);
  if(fresh.length){shelters=dedupe(fresh);saveCache(shelters);render();const off=results[0].status==='fulfilled'?'Київ ✓':'Київ — помилка';const osm=results[1].status==='fulfilled'?'область ✓':'область — помилка';setStatus(`${shelters.length} точок · ${off} · ${osm}`,'ok')}
  else if(!shelters.length)setStatus('Не вдалося завантажити дані. Перевір інтернет.','error')
}

els('search').addEventListener('input',render);
document.querySelectorAll('.chip').forEach(c=>c.onclick=()=>{document.querySelectorAll('.chip').forEach(x=>x.classList.remove('active'));c.classList.add('active');activeFilter=c.dataset.filter;render()});
els('locateBtn').onclick=()=>{
  if(!navigator.geolocation)return setStatus('Геолокація недоступна','error');
  setStatus('Визначаю місцезнаходження…');
  navigator.geolocation.getCurrentPosition(p=>{
    userPos={lat:p.coords.latitude,lng:p.coords.longitude};map.setView([userPos.lat,userPos.lng],14);
    if(userMarker)map.removeLayer(userMarker);
    userMarker=L.circleMarker([userPos.lat,userPos.lng],{radius:8,color:'#fff',weight:3,fillColor:'#ffcb57',fillOpacity:1}).addTo(map).bindPopup('Ви тут');
    render();els('listHint').textContent='Відсортовано за відстанню від вас';setStatus('Геолокацію визначено','ok')
  },()=>setStatus('Не вдалося отримати геолокацію','error'),{enableHighAccuracy:true,timeout:12000});
};
els('nearestGo').onclick=()=>{if(nearestShelter){openShelter(nearestShelter);map.setView([nearestShelter.lat,nearestShelter.lng],17)}};
els('closeSheet').onclick=()=>els('sheet').classList.remove('open');
els('listBtn').onclick=()=>els('listPanel').classList.add('open');
els('closeList').onclick=()=>els('listPanel').classList.remove('open');
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredPrompt=e;els('installBtn').classList.remove('hidden')});
els('installBtn').onclick=async()=>{if(deferredPrompt){deferredPrompt.prompt();await deferredPrompt.userChoice;deferredPrompt=null;els('installBtn').classList.add('hidden')}};
if('serviceWorker' in navigator)navigator.serviceWorker.register('./sw.js').catch(()=>{});
loadData();refreshAlert();setInterval(refreshAlert,60000);