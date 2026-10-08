(function(){
  "use strict";

  const STORE_KEY = "sathi_logs_v1";
  const CONTACTS_KEY = "sathi_contacts_v1";

  function loadJSON(key, fallback){
    try{
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    }catch(e){ return fallback; }
  }
  function saveJSON(key, val){
    try{ localStorage.setItem(key, JSON.stringify(val)); }catch(e){ /* storage unavailable */ }
  }

  let logs = loadJSON(STORE_KEY, []);
  let contacts = loadJSON(CONTACTS_KEY, []);

  const todayLabel = document.getElementById("todayLabel");
  todayLabel.textContent = new Date().toLocaleDateString(undefined, {weekday:'long', month:'long', day:'numeric'});

  // ---------------- Recording + analysis ----------------
  const micBtn = document.getElementById("micBtn");
  const micIcon = document.getElementById("micIcon");
  const statusLine = document.getElementById("statusLine");
  const ringCanvas = document.getElementById("ringCanvas");
  const ringCtx = ringCanvas.getContext("2d");

  const RECORD_SECONDS = 25;
  let recording = false;
  let audioCtx, analyser, mediaStream, sourceNode, dataArray, rafId;
  let envelopeSamples = [];
  let recordStart = 0;

  function drawRing(progress, isRecording){
    const w = ringCanvas.width, h = ringCanvas.height;
    ringCtx.clearRect(0,0,w,h);
    const cx = w/2, cy = h/2, r = 74;
    ringCtx.lineWidth = 10;
    ringCtx.strokeStyle = getComputedStyle(document.body).getPropertyValue('--line');
    ringCtx.beginPath();
    ringCtx.arc(cx, cy, r, 0, Math.PI*2);
    ringCtx.stroke();

    if(isRecording){
      ringCtx.strokeStyle = getComputedStyle(document.body).getPropertyValue('--blue');
      ringCtx.lineCap = "round";
      ringCtx.beginPath();
      ringCtx.arc(cx, cy, r, -Math.PI/2, -Math.PI/2 + progress*Math.PI*2);
      ringCtx.stroke();
    }
  }
  drawRing(0,false);

  async function startRecording(){
    if(recording) return;
    try{
      mediaStream = await navigator.mediaDevices.getUserMedia({audio:true});
    }catch(err){
      statusLine.textContent = "Microphone access was blocked. Please allow microphone access to check in.";
      return;
    }

    recording = true;
    envelopeSamples = [];
    micBtn.classList.add("recording");
    micIcon.textContent = "⏺️";
    statusLine.textContent = "Listening… breathe normally";
    statusLine.classList.add("active");

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    sourceNode = audioCtx.createMediaStreamSource(mediaStream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    sourceNode.connect(analyser);
    dataArray = new Uint8Array(analyser.fftSize);

    recordStart = performance.now();

    function sample(){
      analyser.getByteTimeDomainData(dataArray);
      // compute RMS amplitude of this frame, centered on 128
      let sumSquares = 0;
      for(let i=0;i<dataArray.length;i++){
        const v = (dataArray[i]-128)/128;
        sumSquares += v*v;
      }
      const rms = Math.sqrt(sumSquares/dataArray.length);
      envelopeSamples.push({ t: performance.now()-recordStart, v: rms });

      const elapsed = (performance.now()-recordStart)/1000;
      const progress = Math.min(elapsed/RECORD_SECONDS, 1);
      drawRing(progress, true);

      if(elapsed < RECORD_SECONDS){
        rafId = requestAnimationFrame(sample);
      }else{
        finishRecording();
      }
    }
    rafId = requestAnimationFrame(sample);
  }

  function finishRecording(){
    recording = false;
    micBtn.classList.remove("recording");
    micIcon.textContent = "🎙️";
    statusLine.classList.remove("active");
    statusLine.textContent = "Analyzing…";

    cancelAnimationFrame(rafId);
    if(mediaStream){ mediaStream.getTracks().forEach(t=>t.stop()); }
    if(audioCtx){ audioCtx.close(); }
    drawRing(0,false);

    setTimeout(()=>{
      const result = analyzeEnvelope(envelopeSamples);
      const entry = {
        date: new Date().toISOString(),
        rate: result.breathsPerMinute,
        regularity: result.regularityScore,
        avgLevel: result.avgLevel
      };
      logs.unshift(entry);
      logs = logs.slice(0, 30);
      saveJSON(STORE_KEY, logs);

      statusLine.textContent = "Check-in saved. Tap the microphone to check in again.";
      renderAll();
    }, 300);
  }

  micBtn.addEventListener("click", ()=>{
    if(!recording) startRecording();
  });

  // Smooth the raw RMS envelope, find peaks spaced like breath cycles,
  // and score how evenly spaced those peaks are.
  function analyzeEnvelope(samples){
    if(samples.length < 20){
      return { breathsPerMinute: null, regularityScore: null, avgLevel: 0 };
    }
    // smooth with a simple moving average
    const smoothed = [];
    const win = 8;
    for(let i=0;i<samples.length;i++){
      let sum=0, count=0;
      for(let j=Math.max(0,i-win); j<=Math.min(samples.length-1,i+win); j++){
        sum += samples[j].v; count++;
      }
      smoothed.push({ t: samples[i].t, v: sum/count });
    }
    const avgLevel = smoothed.reduce((a,s)=>a+s.v,0)/smoothed.length;

    // peak picking: local maxima above a threshold, with a minimum spacing
    const peaks = [];
    const minSpacingMs = 1200; // avoid double-counting the same breath
    const threshold = avgLevel * 1.05;
    for(let i=2;i<smoothed.length-2;i++){
      const p = smoothed[i];
      if(p.v > threshold &&
         p.v >= smoothed[i-1].v && p.v >= smoothed[i-2].v &&
         p.v >= smoothed[i+1].v && p.v >= smoothed[i+2].v){
        if(peaks.length===0 || (p.t - peaks[peaks.length-1]) > minSpacingMs){
          peaks.push(p.t);
        }
      }
    }

    let breathsPerMinute = null, regularityScore = null;
    if(peaks.length >= 2){
      const intervals = [];
      for(let i=1;i<peaks.length;i++) intervals.push(peaks[i]-peaks[i-1]);
      const avgInterval = intervals.reduce((a,b)=>a+b,0)/intervals.length;
      breathsPerMinute = Math.round(60000/avgInterval);

      // regularity: lower variance in interval length -> higher score (0-100)
      const variance = intervals.reduce((a,b)=>a+Math.pow(b-avgInterval,2),0)/intervals.length;
      const stdDev = Math.sqrt(variance);
      const cv = avgInterval>0 ? stdDev/avgInterval : 1; // coefficient of variation
      regularityScore = Math.max(0, Math.round(100 - cv*140));
    }

    return { breathsPerMinute, regularityScore, avgLevel };
  }

  // ---------------- Rendering ----------------
  const snapRate = document.getElementById("snapRate");
  const snapRegularity = document.getElementById("snapRegularity");
  const snapTrend = document.getElementById("snapTrend");
  const snapshotDate = document.getElementById("snapshotDate");
  const historyWrap = document.getElementById("historyWrap");
  const alertBanner = document.getElementById("alertBanner");
  const alertDetail = document.getElementById("alertDetail");
  const trendCanvas = document.getElementById("trendChart");
  const trendCtx = trendCanvas.getContext("2d");

  function fmtDate(iso){
    const d = new Date(iso);
    return d.toLocaleDateString(undefined,{month:'short',day:'numeric'}) + " · " +
           d.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'});
  }

  function renderSnapshot(){
    if(logs.length===0){
      snapshotDate.textContent = "No check-in yet today";
      snapRate.textContent = "—";
      snapRegularity.textContent = "—";
      snapTrend.textContent = "—";
      return;
    }
    const latest = logs[0];
    snapshotDate.textContent = fmtDate(latest.date);
    snapRate.textContent = latest.rate ? latest.rate + " br/min" : "Not enough signal";
    if(latest.regularity !== null){
      const label = latest.regularity>=70 ? "Steady" : latest.regularity>=45 ? "Somewhat uneven" : "Uneven";
      const cls = latest.regularity>=70 ? "good" : latest.regularity>=45 ? "neutral" : "watch";
      snapRegularity.innerHTML = latest.regularity + "/100 <span class='pill "+cls+"' style='margin-left:6px;font-size:12px;'>"+label+"</span>";
    } else {
      snapRegularity.textContent = "Not enough signal";
    }

    const lastWeek = logs.filter(l => {
      const days = (Date.now()-new Date(l.date).getTime())/86400000;
      return days>=6 && days<=8;
    });
    if(lastWeek.length && latest.regularity!==null){
      const avgWeekAgo = lastWeek.reduce((a,l)=>a+(l.regularity||0),0)/lastWeek.length;
      const diff = Math.round(latest.regularity - avgWeekAgo);
      snapTrend.textContent = (diff>=0 ? "+" : "") + diff + " pts";
    } else {
      snapTrend.textContent = "Not enough history yet";
    }
  }

  function renderHistory(){
    if(logs.length===0){
      historyWrap.innerHTML = '<p class="empty-state">Your check-ins will appear here once you record your first one.</p>';
      return;
    }
    let rows = logs.map(l=>{
      const reg = l.regularity===null ? "—" : l.regularity+"/100";
      const rate = l.rate ? l.rate+" br/min" : "—";
      return "<tr><td>"+fmtDate(l.date)+"</td><td>"+rate+"</td><td>"+reg+"</td></tr>";
    }).join("");
    historyWrap.innerHTML =
      "<table><thead><tr><th>When</th><th>Breathing rate</th><th>Regularity</th></tr></thead><tbody>"+rows+"</tbody></table>";
  }

  function renderTrendChart(){
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = trendCanvas.clientWidth || 400;
    const cssHeight = 180;
    trendCanvas.width = cssWidth*dpr;
    trendCanvas.height = cssHeight*dpr;
    trendCtx.setTransform(dpr,0,0,dpr,0,0);
    trendCtx.clearRect(0,0,cssWidth,cssHeight);

    const points = logs.slice(0,30).filter(l=>l.regularity!==null).reverse();
    const pad = 24;
    const lineColor = getComputedStyle(document.body).getPropertyValue('--blue-deep');
    const gridColor = getComputedStyle(document.body).getPropertyValue('--line');
    const fillColor = getComputedStyle(document.body).getPropertyValue('--blue-pale');

    // gridlines
    trendCtx.strokeStyle = gridColor;
    trendCtx.lineWidth = 1;
    for(let i=0;i<=4;i++){
      const y = pad + (cssHeight-pad*1.5) * (i/4);
      trendCtx.beginPath();
      trendCtx.moveTo(pad, y);
      trendCtx.lineTo(cssWidth-8, y);
      trendCtx.stroke();
    }

    if(points.length < 2){
      trendCtx.fillStyle = getComputedStyle(document.body).getPropertyValue('--ink-soft');
      trendCtx.font = "15px 'Atkinson Hyperlegible'";
      trendCtx.fillText("Check in a few more days to see your trend", pad, cssHeight/2);
      return;
    }

    const stepX = (cssWidth - pad - 12) / (points.length-1);
    function yFor(v){
      return pad + (cssHeight-pad*1.5) * (1 - v/100);
    }

    trendCtx.beginPath();
    points.forEach((p,i)=>{
      const x = pad + i*stepX;
      const y = yFor(p.regularity);
      if(i===0) trendCtx.moveTo(x,y); else trendCtx.lineTo(x,y);
    });
    trendCtx.lineTo(pad + (points.length-1)*stepX, cssHeight-pad*0.5);
    trendCtx.lineTo(pad, cssHeight-pad*0.5);
    trendCtx.closePath();
    trendCtx.fillStyle = fillColor;
    trendCtx.fill();

    trendCtx.beginPath();
    points.forEach((p,i)=>{
      const x = pad + i*stepX;
      const y = yFor(p.regularity);
      if(i===0) trendCtx.moveTo(x,y); else trendCtx.lineTo(x,y);
    });
    trendCtx.strokeStyle = lineColor;
    trendCtx.lineWidth = 2.5;
    trendCtx.lineJoin = "round";
    trendCtx.stroke();

    points.forEach((p,i)=>{
      const x = pad + i*stepX;
      const y = yFor(p.regularity);
      trendCtx.beginPath();
      trendCtx.arc(x,y,3,0,Math.PI*2);
      trendCtx.fillStyle = lineColor;
      trendCtx.fill();
    });
  }

  function renderAlert(){
    const recent = logs.slice(0,3).filter(l=>l.regularity!==null);
    const lowCount = recent.filter(l=>l.regularity < 45).length;
    if(recent.length>=2 && lowCount>=2){
      alertBanner.classList.add("show");
      alertDetail.textContent = "The last "+recent.length+" check-ins showed lower breathing regularity than usual. This is not a diagnosis — consider mentioning it to a doctor.";
    }else{
      alertBanner.classList.remove("show");
    }
  }

  function renderAll(){
    renderSnapshot();
    renderHistory();
    renderTrendChart();
    renderAlert();
  }

  // ---------------- Care circle ----------------
  const contactList = document.getElementById("contactList");
  const contactForm = document.getElementById("contactForm");
  const addContactBtn = document.getElementById("addContactBtn");

  function renderContacts(){
    if(contacts.length===0){
      contactList.innerHTML = '<li class="empty-state" style="border-bottom:none;">No one added yet.</li>';
      return;
    }
    contactList.innerHTML = contacts.map((c,i)=>{
      const latest = logs[0];
      const summary = latest
        ? "Latest check-in: "+fmtDate(latest.date)+", regularity "+(latest.regularity??"—")+"/100, rate "+(latest.rate?latest.rate+" br/min":"—")
        : "No check-ins recorded yet.";
      const subject = encodeURIComponent("Sāthī health check-in update");
      const body = encodeURIComponent("Hi "+c.name+",\n\nSharing a quick update from Sāthī:\n\n"+summary+"\n\nThis is not a medical diagnosis, just a home wellness note.\n");
      const howText = c.phone ? escapeHtml(c.email)+" · "+escapeHtml(c.phone) : escapeHtml(c.email);
      const callBtn = c.phone ? "<a class='btn' href='tel:"+c.phone.replace(/[^0-9+]/g,'')+"'>📞 Call</a>" : "";
      return "<li><div><div class='who'>"+escapeHtml(c.name)+"</div><div class='how'>"+howText+"</div></div>"+
        "<div style='display:flex;gap:10px;align-items:center;flex-wrap:wrap;'>"+
        callBtn+
        "<a class='btn' href='mailto:"+c.email+"?subject="+subject+"&body="+body+"'>✉ Notify</a>"+
        "<button class='remove-link' data-idx='"+i+"'>Remove</button>"+
        "</div></li>";
    }).join("");

    contactList.querySelectorAll(".remove-link").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        const idx = parseInt(btn.getAttribute("data-idx"),10);
        contacts.splice(idx,1);
        saveJSON(CONTACTS_KEY, contacts);
        renderContacts();
        renderQuickCallRow();
      });
    });

    renderQuickCallRow();
  }

  function renderQuickCallRow(){
    const row = document.getElementById("quickCallRow");
    if(!row) return;
    const withPhone = contacts.filter(c=>c.phone);
    if(withPhone.length===0){
      row.innerHTML = '<span style="font-size:14px;color:var(--ink-soft);">Add a phone number to a care-circle contact to enable one-tap calling here.</span>';
      return;
    }
    row.innerHTML = withPhone.map(c=>
      "<a class='call-chip' href='tel:"+c.phone.replace(/[^0-9+]/g,'')+"'>📞 Call "+escapeHtml(c.name)+"</a>"
    ).join("");
  }

  function triggerAlert(){
    if(contacts.length===0){
      alert("Add at least one person to your care circle first, so Sāthī knows who to alert.");
      return;
    }
    const latest = logs[0];
    const summary = latest
      ? "Latest check-in: "+fmtDate(latest.date)+", regularity "+(latest.regularity??"—")+"/100, breathing rate "+(latest.rate?latest.rate+" br/min":"—")
      : "No check-ins recorded yet.";
    const toList = contacts.map(c=>c.email).filter(Boolean).join(",");
    const subject = encodeURIComponent("URGENT — please check on me (Sāthī alert)");
    const body = encodeURIComponent("This is an urgent alert sent from Sāthī.\n\n"+summary+"\n\nPlease check on me, or call, as soon as you can.\n");
    window.location.href = "mailto:"+toList+"?subject="+subject+"&body="+body;
  }

  function findPharmacy(){
    const openGeneric = ()=>window.open("https://www.google.com/maps/search/pharmacy+near+me", "_blank", "noopener");
    if(navigator.geolocation){
      navigator.geolocation.getCurrentPosition(
        pos=>{
          const {latitude, longitude} = pos.coords;
          window.open("https://www.google.com/maps/search/pharmacy/@"+latitude+","+longitude+",15z", "_blank", "noopener");
        },
        openGeneric,
        {timeout:5000}
      );
    } else {
      openGeneric();
    }
  }

  function escapeHtml(s){
    return s.replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  }

  addContactBtn.addEventListener("click", (e)=>{
    e.preventDefault();
    const name = document.getElementById("contactName").value.trim();
    const email = document.getElementById("contactEmail").value.trim();
    const phone = document.getElementById("contactPhone").value.trim();
    if(!name || !email) return;
    contacts.push({name, email, phone});
    saveJSON(CONTACTS_KEY, contacts);
    contactForm.reset();
    renderContacts();
  });

  document.getElementById("alertBtn").addEventListener("click", triggerAlert);
  document.getElementById("findPharmacyBtn").addEventListener("click", findPharmacy);

  // ---------------- Export / clear ----------------
  document.getElementById("exportBtn").addEventListener("click", ()=>{
    if(logs.length===0) return;
    const header = "date,breathing_rate_bpm,regularity_score\n";
    const rows = logs.map(l=>[l.date, l.rate??"", l.regularity??""].join(",")).join("\n");
    const blob = new Blob([header+rows], {type:"text/csv"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "sathi-checkins.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });

  document.getElementById("clearBtn").addEventListener("click", ()=>{
    if(!confirm("Remove all saved check-ins from this device? This cannot be undone.")) return;
    logs = [];
    saveJSON(STORE_KEY, logs);
    renderAll();
  });

  window.addEventListener("resize", renderTrendChart);

  renderAll();
  renderContacts();
})();
