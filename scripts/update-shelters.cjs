const fs = require('fs');

const KYIV_API = 'https://gisserver.kyivcity.gov.ua/mayno/rest/services/KYIV_API/Public_protection/MapServer/0/query?where=1%3D1&outFields=*&returnGeometry=true&f=geojson&outSR=4326';
const DSNS_GET = 'https://shelters.dsns.gov.ua/api/v1/public/ukryttya/get';
const DSNS_REGIONS = 'https://shelters.dsns.gov.ua/api/v1/public/katootth/regions';
const OVERPASS = ['https://overpass-api.de/api/interpreter','https://overpass.kumi.systems/api/interpreter'];
const OSM_AREA = 3600071248;

function first(p,...keys){for(const k of keys){const v=p?.[k];if(v!==undefined&&v!==null&&String(v).trim())return String(v).trim()}return''}
function nestedName(v){return String(v?.imya||v?.name||v?.nazva||'').trim()}
function isKyivRegionName(name){const n=String(name||'').toLowerCase().replace(/’/g,"'");return n.includes('київська')||n==='м. київ'||n==='київ'||n.includes('kyiv oblast')||n==='kyiv'}
function isKyivCityName(name){const n=String(name||'').toLowerCase().trim();return n==='м. київ'||n==='київ'||n==='kyiv'}
function normalizeCity(p,lat,lng,id){
  const raw=[p.type_building,p.type,p.shelter_type,p.description,p.name].filter(Boolean).join(' ').toLowerCase();
  const type=raw.includes('найпрост')||raw.includes('simple')?'simple':'shelter';
  const address=first(p,'address','full_address','adress','addr')||[first(p,'addr:city','city','settlement'),[first(p,'addr:street','street','street_name'),first(p,'addr:housenumber','house','building_num')].filter(Boolean).join(', ')].filter(Boolean).join(', ')||'Адресу не вказано';
  return {id,lat,lng,source:'kyiv_official',type,name:first(p,'name','title','type_building')||(type==='simple'?'Найпростіше укриття':'Укриття'),address,city:'Київ',region:'м. Київ',district:'',community:'',accessible:/yes|так|true|доступ/i.test([p.disabled,p.accessibility,p.wheelchair,p.invalid,p.mgn].filter(Boolean).join(' ')),hours:first(p,'opening_hours','work_time','working_hours','hours'),photo:'',capacity:''};
}
async function fetchCity(){
  const r=await fetch(KYIV_API);if(!r.ok)throw new Error('Kyiv '+r.status);const gj=await r.json();
  return (gj.features||[]).map((f,i)=>{if(f?.geometry?.type!=='Point')return null;const [lng,lat]=f.geometry.coordinates||[];if(!Number.isFinite(lat)||!Number.isFinite(lng))return null;return normalizeCity(f.properties||{},lat,lng,'kyiv:'+(f.id||i))}).filter(Boolean);
}
async function getRegionIds(){
  try{const r=await fetch(DSNS_REGIONS);if(!r.ok)return[];const raw=await r.json();const list=Array.isArray(raw)?raw:Array.isArray(raw?.data)?raw.data:[];return list.filter(x=>isKyivRegionName(x?.name||x?.nazva||x?.imya)).map(x=>x.id).filter(x=>x!==undefined&&x!==null)}catch{return[]}
}
async function fetchDsns(){
  const regionIds=await getRegionIds(),out=[],limit=1000;
  for(let page=0;page<12;page++){
    const body={search:'',versiyaId:null,yeVyklyuchenoyu:null,format:'json',sortBy:'',sortOrder:'',dataProvedennyaOtsinkyStanuHotovnosti:'',formaVlasnostiId:[],isMinimumInfo:false,katehoriyaNaselennyaId:[],limit,maxMistkist:null,maxPloshcha:null,maxRikVvedennyaVEkspluatatsiyu:null,minMistkist:null,minPloshcha:null,minRikVvedennyaVEkspluatatsiyu:null,nayavniZasobyZvyazkuId:[],nayavnistDostupuMalomobilnykhVerstvNaselennya:null,nayavnistYERODV:null,nazvaBalansoutrymuvacha:'',nazvaNaselenohoPunktuId:[],nazvaRayonuMistaId:[],nebezpechniZonyId:[],oblikovyyNomerMistyt:'',osnovnyjVydEkonDiyalnostiId:[],rayonId:[],rehionId:regionIds,reyestrovyyNomerSporudy:'',rezhymyFiltroventylyatsiyiId:[],searchOnlyFields:[],skip:page*limit,stanHotovnostiId:[],statusProvedennyaInventaryzatsiyi:null,terytorialnaHromadaId:[],typSporudyId:[],vydSporudyId:[],yurydychnaAdresaBalansoutrymuvacha:'',zakhysniVlastyvostiId:[]};
    const r=await fetch(DSNS_GET,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});if(!r.ok)throw new Error('DSNS '+r.status);const p=await r.json();const items=Array.isArray(p?.data?.items)?p.data.items:[];if(!items.length)break;
    for(const x of items){
      if(x?.yeVyklyuchenoyu===true)continue;
      const region=nestedName(x?.Rehion);if(!regionIds.length&&!isKyivRegionName(region))continue;
      const lat=Number(x?.shyrota),lng=Number(x?.dovhota);if(!Number.isFinite(lat)||!Number.isFinite(lng)||Math.abs(lat)>90||Math.abs(lng)>180)continue;
      const place=nestedName(x?.NazvaNaselenohoPunktu),kind=nestedName(x?.VydSporudy)||nestedName(x?.TypSporudy)||x?.imya||x?.naimenuvanniaMistsiaDliaUkryttia||'Укриття';
      const address=[place,x?.nazvaVulytsi,x?.inshiRekvizytyAdresy].filter(Boolean).join(', ')||'Адресу не вказано';
      const av=x?.nayavnistDostupuMalomobilnykhVerstvNaselennya;
      out.push({id:'dsns:'+String(x?.id??x?.oblikovyyNomer??lat+','+lng),lat,lng,source:'dsns',type:/найпрост/i.test(kind)?'simple':'shelter',name:x?.naimenuvanniaMistsiaDliaUkryttia||kind,address,city:place,region,district:nestedName(x?.Rayon),community:nestedName(x?.TerytorialnaHromada),accessible:av===true||/так|yes|наяв|доступ/i.test(String(av||'')),hours:'',photo:'',capacity:x?.mistkistOsib??'',readiness:nestedName(x?.StanHotovnosti),registry_number:x?.oblikovyyNomer||''});
    }
    if(items.length<limit)break;
  }
  return out;
}
async function fetchOsmFallback(){
  const q=`[out:json][timeout:55];area(${OSM_AREA})->.a;(nwr["amenity"="shelter"](area.a);nwr["emergency"="shelter"](area.a);nwr["shelter_type"](area.a);nwr["military"="bunker"]["bunker_type"="civil_defense"](area.a););out center tags qt;`;
  for(const ep of OVERPASS){try{const r=await fetch(ep,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8'},body:'data='+encodeURIComponent(q)});if(!r.ok)continue;const j=await r.json();return (j.elements||[]).map(e=>{const lat=e.lat??e.center?.lat,lng=e.lon??e.center?.lon;if(!Number.isFinite(lat)||!Number.isFinite(lng))return null;const p=e.tags||{},city=first(p,'addr:city','city','settlement'),street=first(p,'addr:street'),house=first(p,'addr:housenumber');return{id:'osm:'+e.type+':'+e.id,lat,lng,source:'dsns',type:String(p.shelter_type||'').includes('simple')?'simple':'shelter',name:first(p,'name')||'Укриття',address:[city,[street,house].filter(Boolean).join(', ')].filter(Boolean).join(', ')||'Адресу не вказано',city,region:'Київська область',district:'',community:'',accessible:String(p.wheelchair||'').toLowerCase()==='yes',hours:first(p,'opening_hours'),photo:first(p,'image'),capacity:first(p,'capacity')}}).filter(Boolean)}catch{}}return[];
}
function dedupe(items){const out=[],seen=new Set();for(const s of items){const k=Math.round(s.lat*10000)+'|'+Math.round(s.lng*10000);if(seen.has(k))continue;seen.add(k);out.push(s)}return out}

(async()=>{
  const [cityR,dsnsR]=await Promise.allSettled([fetchCity(),fetchDsns()]);
  const city=cityR.status==='fulfilled'?cityR.value:[];
  let oblast=dsnsR.status==='fulfilled'?dsnsR.value.filter(x=>!isKyivCityName(x.region)):[];
  if(!oblast.length)oblast=await fetchOsmFallback();
  const shelters=dedupe([...city,...oblast]);
  if(!shelters.length)throw new Error('No shelter data');
  const payload={shelters,counts:{total:shelters.length,kyiv_official:city.length,oblast_dsns:oblast.length},partial:cityR.status!=='fulfilled'||dsnsR.status!=='fulfilled',updated_at:new Date().toISOString()};
  fs.writeFileSync('shelters.json',JSON.stringify(payload));
  console.log('saved',payload.counts);
})().catch(e=>{console.error(e);process.exit(1)});
