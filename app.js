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
const SEARCH_DELAY=160;
const MAP_STYLE_KEY='bespeka-map-style-v2';
const ALERT_OVERLAY_KEY='bespeka-alert-overlay-v1';
const ALERTS_CACHE_KEY='bespeka-alerts-v1';
const OVERPASS_ENDPOINTS=['https://overpass-api.de/api/interpreter','https://overpass.kumi.systems/api/interpreter'];
const $=id=>document.getElementById(id);

let shelters=[],filtered=[],activeFilter='all',searchQuery='',userPos=null,userMarker=null,nearestShelter=null,listLimit=250,searchTimer=null;
let alerts=[],alertScope='kyiv',alertMapLayer=null,alertMapLabels=[],alertOverlayLayer=null,alertOverlayLabels=[];
let currentTab='map',deferredPrompt=null,map3d=null,map3dReady=false,active3dShelter=null;
const favorites=new Set(JSON.parse(localStorage.getItem(FAV_KEY)||'[]'));

const baseLayers={
  classic:L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
    maxZoom:19,attribution:'© OpenStreetMap contributors'
  }),
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
let mapStyle=localStorage.getItem(MAP_STYLE_KEY)||'classic';
let alertOverlayEnabled=localStorage.getItem(ALERT_OVERLAY_KEY)==='1';

const map=L.map('map',{zoomControl:true,preferCanvas:true}).setView([50.35,30.42],9);
(baseLayers[mapStyle]||baseLayers.classic).addTo(map);
const clusters=L.markerClusterGroup({showCoverageOnHover:false,maxClusterRadius:44,spiderfyOnMaxZoom:true,chunkedLoading:true,chunkInterval:80,chunkDelay:18,removeOutsideVisibleBounds:true});
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
  clearTimeout(searchTimer);
  searchTimer=setTimeout(()=>applyFilter(false),SEARCH_DELAY);
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
  render3dShelters();
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
    <div class="map-actions">
      <button id="showMapBtn" class="show-map-btn">⌖ Показати на карті</button>
      <button id="view3dBtn" class="walk3d-btn">◫ 3D квартал</button>
    </div>
    <button id="favToggle" class="fav-btn">${fav?'★ Прибрати з обраного':'☆ Додати в обране'}</button>
    <p class="note">Перевір фактичну доступність входу перед використанням. Позначені на 3D-карті входи будівель не є підтвердженням входу саме до укриття.</p>`;
  $('detailsSheet').classList.add('open');
  $('showMapBtn').onclick=()=>{switchTab('map');focusShelter(s,17);$('detailsSheet').classList.remove('open')};
  $('view3dBtn').onclick=()=>flyToShelter3d(s);
  $('favToggle').onclick=()=>{favorites.has(s.id)?favorites.delete(s.id):favorites.add(s.id);saveFavs();openShelter(s);applyFilter(false)};
}

function shelterGeoJson(){
  return {type:'FeatureCollection',features:filtered.map(s=>({
    type:'Feature',
    geometry:{type:'Point',coordinates:[s.lng,s.lat]},
    properties:{id:s.id,source:s.source,name:s.name,address:s.address||''}
  }))};
}
function emptyGeoJson(){return{type:'FeatureCollection',features:[]}}

function add3dLayers(){
  if(!map3d||!map3d.isStyleLoaded())return;
  const style=map3d.getStyle();
  const firstSymbol=style.layers?.find(l=>l.type==='symbol')?.id;
  const vectorSourceId=Object.entries(style.sources||{}).find(([,v])=>v?.type==='vector')?.[0];
  if(vectorSourceId&&!map3d.getLayer('bespeka-buildings-3d')){
    try{
      map3d.addLayer({
        id:'bespeka-buildings-3d',
        source:vectorSourceId,
        'source-layer':'building',
        type:'fill-extrusion',
        minzoom:14.4,
        paint:{
          'fill-extrusion-color':['interpolate',['linear'],['zoom'],14.4,'#26384d',18,'#6d839a'],
          'fill-extrusion-height':['coalesce',['get','render_height'],6],
          'fill-extrusion-base':['coalesce',['get','render_min_height'],0],
          'fill-extrusion-opacity':0.94,
          'fill-extrusion-vertical-gradient':true
        }
      },firstSymbol);
    }catch{}
  }
  if(!map3d.getSource('bespeka-shelters')){
    map3d.addSource('bespeka-shelters',{type:'geojson',data:shelterGeoJson()});
    map3d.addLayer({
      id:'bespeka-shelters',
      type:'circle',
      source:'bespeka-shelters',
      paint:{
        'circle-radius':['interpolate',['linear'],['zoom'],8,3,14,6,18,9],
        'circle-color':['match',['get','source'],'kyiv_official','#4ade8d','#67aefc'],
        'circle-stroke-color':'#ffffff',
        'circle-stroke-width':['interpolate',['linear'],['zoom'],8,1,18,2.5],
        'circle-opacity':0.95
      }
    });
    map3d.on('click','bespeka-shelters',e=>{
      const id=e.features?.[0]?.properties?.id;
      const s=shelters.find(x=>x.id===id);
      if(s)openShelter(s);
    });
    map3d.on('mouseenter','bespeka-shelters',()=>map3d.getCanvas().style.cursor='pointer');
    map3d.on('mouseleave','bespeka-shelters',()=>map3d.getCanvas().style.cursor='');
  }
  if(!map3d.getSource('bespeka-entrances')){
    map3d.addSource('bespeka-entrances',{type:'geojson',data:emptyGeoJson()});
    map3d.addLayer({
      id:'bespeka-entrances',
      type:'circle',
      source:'bespeka-entrances',
      minzoom:16,
      paint:{
        'circle-radius':7,
        'circle-color':'#f2c94c',
        'circle-stroke-color':'#111827',
        'circle-stroke-width':2
      }
    });
    map3d.on('click','bespeka-entrances',e=>{
      const p=e.features?.[0]?.properties||{};
      new maplibregl.Popup({closeButton:false,offset:12})
        .setLngLat(e.lngLat)
        .setHTML('<b>Вхід будівлі</b><br><small>'+esc(p.kind||'позначено в OpenStreetMap')+' · не підтверджено як вхід до укриття</small>')
        .addTo(map3d);
    });
  }
}
function init3dMap(){
  if(map3d||!window.maplibregl)return;
  const c=map.getCenter();
  map3d=new maplibregl.Map({
    container:'map3d',
    style:'https://tiles.openfreemap.org/styles/liberty',
    center:[c.lng,c.lat],
    zoom:Math.max(8,map.getZoom()),
    pitch:58,
    bearing:-16,
    maxPitch:85,
    antialias:true,
    attributionControl:true
  });
  map3d.addControl(new maplibregl.NavigationControl({visualizePitch:true}),'bottom-right');
  map3d.on('style.load',()=>{map3dReady=true;add3dLayers();render3dShelters()});
  map3d.on('error',()=>{if(!map3dReady)$('dataBadge').textContent='3D карта не завантажилась · спробуй ще раз'});
}
function render3dShelters(){
  if(!map3d||!map3dReady)return;
  add3dLayers();
  const src=map3d.getSource('bespeka-shelters');
  if(src)src.setData(shelterGeoJson());
}
async function loadMappedEntrances(s){
  if(!map3d||!map3dReady)return;
  const src=map3d.getSource('bespeka-entrances');
  if(!src)return;
  src.setData(emptyGeoJson());
  const q='[out:json][timeout:12];node(around:120,'+s.lat+','+s.lng+')["entrance"];out body;';
  for(const endpoint of OVERPASS_ENDPOINTS){
    try{
      const data=await fetchJson(endpoint+'?data='+encodeURIComponent(q),14000);
      const features=(data.elements||[]).filter(x=>Number.isFinite(x.lat)&&Number.isFinite(x.lon)).map(x=>({
        type:'Feature',
        geometry:{type:'Point',coordinates:[x.lon,x.lat]},
        properties:{kind:x.tags?.entrance||'вхід',name:x.tags?.name||''}
      }));
      src.setData({type:'FeatureCollection',features});
      $('dataBadge').textContent=features.length?'3D · входів будівель поруч: '+features.length:'3D · входи будівель поруч не позначені в OSM';
      return;
    }catch{}
  }
  $('dataBadge').textContent='3D · будинки OSM · входи тимчасово недоступні';
}
function set3dHudMode(mode){
  document.querySelectorAll('.hud-btn').forEach(b=>b.classList.toggle('active',b.id===(mode==='street'?'street3dBtn':'district3dBtn')));
}
function focusShelter(s,zoom=17){
  if(!s)return;
  if(mapStyle==='3d'&&map3d){
    active3dShelter=s;
    render3dShelters();
    map3d.flyTo({center:[s.lng,s.lat],zoom:Math.max(zoom,17.5),pitch:64,bearing:-18,duration:800,essential:true});
  }else map.setView([s.lat,s.lng],zoom);
}
function flyToShelter3d(s){
  active3dShelter=s;
  $('detailsSheet').classList.remove('open');
  switchTab('map');
  setMapStyle('3d');
  let attempts=0;
  const go=()=>{
    attempts++;
    if(!map3d||!map3dReady){
      if(attempts<50)return setTimeout(go,120);
      $('dataBadge').textContent='Не вдалося відкрити 3D';
      return;
    }
    set3dHudMode('district');
    map3d.flyTo({center:[s.lng,s.lat],zoom:18.2,pitch:68,bearing:-28,duration:1100,essential:true});
    loadMappedEntrances(s);
  };
  go();
}
function setMapStyle(style){
  if(style==='3d'){
    if(!window.maplibregl){
      $('dataBadge').textContent='3D режим недоступний у цьому браузері';
      return;
    }
    init3dMap();
    $('map').classList.add('hidden');
    $('map3d').classList.remove('hidden');
    $('map3dHud').classList.remove('hidden');
    mapStyle='3d';localStorage.setItem(MAP_STYLE_KEY,style);
    document.querySelectorAll('.map-style').forEach(b=>b.classList.toggle('active',b.dataset.mapStyle===style));
    setTimeout(()=>{map3d?.resize();render3dShelters()},60);
    $('dataBadge').textContent='3D · обертай і нахиляй карту двома пальцями';
    return;
  }
  if(!baseLayers[style])style='classic';
  $('map3d').classList.add('hidden');
  $('map3dHud').classList.add('hidden');
  $('map').classList.remove('hidden');
  Object.values(baseLayers).forEach(l=>{if(map.hasLayer(l))map.removeLayer(l)});
  baseLayers[style].addTo(map);
  baseLayers[style].bringToBack();
  mapStyle=style;localStorage.setItem(MAP_STYLE_KEY,style);
  document.querySelectorAll('.map-style').forEach(b=>b.classList.toggle('active',b.dataset.mapStyle===style));
  setTimeout(()=>map.invalidateSize(),40);
}
function fitKyiv(){
  if(mapStyle==='3d'&&map3d){
    map3d.flyTo({center:[30.5,50.25],zoom:8.3,pitch:20,bearing:0,duration:700});
  }else map.fitBounds([[49.0,29.1],[51.7,32.3]],{padding:[20,20]});
}

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
function clientKyivStatus(items,updatedAt){
  const relevant=(items||[]).filter(isKyivOblastAlert);
  const threats=[...new Set(relevant.flatMap(a=>(a.threats||[]).map(t=>t.threat_type).filter(Boolean)))];
  const types=[...new Set(relevant.map(a=>a.alert_type).filter(Boolean))];
  return {
    active:relevant.length>0,
    updated_at:updatedAt||null,
    alert_types:types,
    threats,
    active_locations:relevant.map(a=>({title:a.location_title,raion:a.location_raion,alert_type:a.alert_type}))
  };
}
async function refreshStatus(){
  try{
    const sep=ALERT_PROXY_URL.includes('?')?'&':'?';
    const data=await fetchJson(ALERT_PROXY_URL+sep+'ts='+Date.now(),12000);
    setAlertPill(data);
  }catch{
    try{
      const cached=JSON.parse(localStorage.getItem(ALERTS_CACHE_KEY)||'null');
      if(Array.isArray(cached?.alerts)){
        setAlertPill(clientKyivStatus(cached.alerts,cached.updated_at));
        $('alertPillText').textContent=($('alertPillText').textContent||'Київська область')+' · кеш';
        return;
      }
    }catch{}
    $('alertPill').className='alert-pill state-unknown';
    $('alertPillTitle').textContent='Статус недоступний';
    $('alertPillText').textContent='Оновлю автоматично';
  }
}
async function loadAlerts(){
  try{
    const data=await fetchJson(ALERTS_URL+'?ts='+Date.now(),15000);
    alerts=Array.isArray(data.alerts)?data.alerts:[];
    try{localStorage.setItem(ALERTS_CACHE_KEY,JSON.stringify({alerts,updated_at:data.updated_at}))}catch{}
    $('alertsUpdated').textContent='Оновлено '+formatTime(data.updated_at);
    renderThreats();
    if(alertMapLayer)restyleAlertMap();else await renderAlertMap();
    await syncAlertOverlay();
  }catch{
    try{
      const cached=JSON.parse(localStorage.getItem(ALERTS_CACHE_KEY)||'null');
      if(Array.isArray(cached?.alerts)){
        alerts=cached.alerts;
        $('alertsUpdated').textContent='Кеш · '+formatTime(cached.updated_at);
        renderThreats();
        if(alertMapLayer)restyleAlertMap();else await renderAlertMap();
        await syncAlertOverlay();
        return;
      }
    }catch{}
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

  let data=null,source='live';
  try{
    data=await fetchJson(SHELTERS_URL+'?ts='+Date.now(),65000);
    if(!Array.isArray(data?.shelters)||!data.shelters.length)throw new Error('empty live dataset');
  }catch{
    try{
      data=await fetchJson('./shelters.json?ts='+Date.now(),20000);
      if(!Array.isArray(data?.shelters)||!data.shelters.length)throw new Error('empty snapshot');
      source='snapshot';
    }catch{}
  }

  if(data?.shelters?.length){
    shelters=data.shelters;
    localStorage.setItem(CACHE_KEY,JSON.stringify({shelters,updated_at:data.updated_at}));
    applyFilter(false);
    const city=data.counts?.kyiv_official||0,oblast=data.counts?.oblast_dsns||data.counts?.dsns||0;
    $('dataBadge').textContent=shelters.length+' · Київ '+city+' · область '+oblast+' · '+formatTime(data.updated_at)+(source==='snapshot'?' · резерв':'')+(data.partial?' · частково':'');
  }else{
    $('dataBadge').textContent=shelters.length?shelters.length+' точок · офлайн-кеш':'Укриття тимчасово недоступні';
  }
}

function switchTab(tab){
  currentTab=tab;
  document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));
  $('mapView').classList.toggle('active',tab==='map');
  $('listView').classList.toggle('active',tab==='list');
  $('alertsView').classList.toggle('active',tab==='alerts');
  setTimeout(()=>{
    if(tab==='map'){
      if(mapStyle==='3d'&&map3d)map3d.resize();
      else map.invalidateSize();
    }
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
    if(mapStyle==='3d'&&map3d){
      map3d.flyTo({center:[userPos.lng,userPos.lat],zoom:17.3,pitch:65,bearing:-18,duration:800});
    }else map.setView([userPos.lat,userPos.lng],14);
    applyFilter(false);
    $('dataBadge').textContent=shelters.length+' укриттів';
  },()=>{$('dataBadge').textContent='Геопозицію не отримано'},{enableHighAccuracy:true,timeout:12000});
};
$('fitBtn').onclick=fitKyiv;
$('nearestCard').onclick=()=>{if(nearestShelter){openShelter(nearestShelter);focusShelter(nearestShelter,17)}};
$('alertShelterBtn').onclick=()=>{
  switchTab('map');
  if(userPos&&nearestShelter){openShelter(nearestShelter);focusShelter(nearestShelter,17)}
  else $('locateBtn').click();
};

$('district3dBtn').onclick=()=>{
  if(!map3d)return;
  set3dHudMode('district');
  const c=active3dShelter?[active3dShelter.lng,active3dShelter.lat]:map3d.getCenter().toArray();
  map3d.flyTo({center:c,zoom:active3dShelter?18.2:Math.max(map3d.getZoom(),16.5),pitch:58,bearing:-18,duration:650,essential:true});
};
$('street3dBtn').onclick=()=>{
  if(!map3d)return;
  set3dHudMode('street');
  const c=active3dShelter?[active3dShelter.lng,active3dShelter.lat]:map3d.getCenter().toArray();
  map3d.flyTo({center:c,zoom:active3dShelter?19.1:Math.max(map3d.getZoom(),18.4),pitch:82,bearing:map3d.getBearing()||-24,duration:650,essential:true});
};
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
const initialTab=new URLSearchParams(location.search).get('tab');
if(['map','list','alerts'].includes(initialTab))switchTab(initialTab);
$('alertsOverlayToggle').classList.toggle('on',alertOverlayEnabled);
$('alertsOverlayToggle').setAttribute('aria-pressed',String(alertOverlayEnabled));
loadShelters();
refreshStatus();
loadAlerts();
setInterval(refreshStatus,30000);
setInterval(loadAlerts,45000);
