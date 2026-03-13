// 🗄️ DATABASE INDEXEDDB
const DB_NAME = 'CassaPWA_DB';
const DB_VERSION = 3;
let db;

function initDB() {
    return new Promise((resolve, reject) => {

        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = function (event) {
            db = event.target.result;
            const tx = event.currentTarget.transaction;

            if (!db.objectStoreNames.contains('magazzino')) { db.createObjectStore('magazzino', { keyPath: 'codice' }); }

            let storeClienti;
            if (!db.objectStoreNames.contains('clienti')) { storeClienti = db.createObjectStore('clienti', { keyPath: 'scheda' }); } else { storeClienti = tx.objectStore('clienti'); }
            if (!storeClienti.indexNames.contains('telefono')) { storeClienti.createIndex('telefono', 'telefono', { unique: false }); }

            let storeVendite;
            if (!db.objectStoreNames.contains('vendite')) { storeVendite = db.createObjectStore('vendite', { keyPath: 'id', autoIncrement: true }); } else { storeVendite = tx.objectStore('vendite'); }
            if (!storeVendite.indexNames.contains('giorno')) { storeVendite.createIndex('giorno', 'GIORNO', { unique: false }); }

            let storeMov;
            if (!db.objectStoreNames.contains('movimenti_cassa')) { storeMov = db.createObjectStore('movimenti_cassa', { keyPath: 'id', autoIncrement: true }); } else { storeMov = tx.objectStore('movimenti_cassa'); }
            if (!storeMov.indexNames.contains('data')) { storeMov.createIndex('data', 'data', { unique: false }); }
        };

        request.onsuccess = function (event) {
            db = event.target.result;

            resolve(); // <--- MANCAVA QUESTO COMANDO VITALE! Sblocca l'avvio dell'app.

            // Avvia la sincronizzazione silenziosa in background
            setTimeout(() => {
                scaricaClientiDalCloud();
                scaricaMagazzinoDalCloud();
            }, 4000);
        };

        request.onerror = function (event) { reject("Errore DB: " + event.target.errorCode); };
    });
}

// Helpers DB
function getAll(storeName) { return new Promise((resolve) => { let tx = db.transaction(storeName, 'readonly'); let request = tx.objectStore(storeName).getAll(); request.onsuccess = () => resolve(request.result); }); }
function getByDate(storeName, indexName, dataCercata) { return new Promise((resolve) => { let tx = db.transaction(storeName, 'readonly'); let index = tx.objectStore(storeName).index(indexName); let request = index.getAll(IDBKeyRange.only(dataCercata)); request.onsuccess = () => resolve(request.result); }); }
function getBySchedaOTelefono(valore) { return new Promise((resolve) => { let tx = db.transaction('clienti', 'readonly'); let store = tx.objectStore('clienti'); let reqScheda = store.get(valore); reqScheda.onsuccess = () => { if (reqScheda.result) { resolve(reqScheda.result); } else { let index = store.index('telefono'); let reqTel = index.get(valore); reqTel.onsuccess = () => resolve(reqTel.result); } }; }); }
function updateCliente(cliente) {
    return new Promise((resolve) => {
        let tx = db.transaction('clienti', 'readwrite');
        tx.objectStore('clienti').put(cliente);
        tx.oncomplete = () => {
            // ☁️ CLOUD-SYNC: Appena il dato viene salvato nel PC locale, lo spara al Cloud!
            if (typeof salvaClienteCloud === "function") {
                salvaClienteCloud(cliente);
            }
            resolve();
        };
    });
}
function deleteRecord(storeName, key) { return new Promise((resolve) => { let tx = db.transaction(storeName, 'readwrite'); tx.objectStore(storeName).delete(key); tx.oncomplete = () => resolve(); }); }
function salvaVendita(recordVendita) { return new Promise((resolve) => { let tx = db.transaction('vendite', 'readwrite'); tx.objectStore('vendite').add(recordVendita); tx.oncomplete = () => resolve(); }); }
function salvaMovimentoCassaDB(movimento) {
    return new Promise((resolve) => {
        let tx = db.transaction('movimenti_cassa', 'readwrite');
        let request = tx.objectStore('movimenti_cassa').add(movimento);
        request.onsuccess = (e) => resolve(e.target.result); // Restituisce l'ID per Firebase
    });
}
function getRecordById(storeName, id) { return new Promise((resolve) => { let tx = db.transaction(storeName, 'readonly'); let request = tx.objectStore(storeName).get(id); request.onsuccess = () => resolve(request.result); }); }

// Helper Data
function getOggiString() {
    let d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 🧠 VARIABILI CASSA
const btnCestino = document.getElementById('btn-cestino');
const btnCassa = document.getElementById('btn-cassa');
const btnCalcolatrice = document.getElementById('btn-calcolatrice');
const btnClienti = document.getElementById('btn-clienti');
const btnRegistro = document.getElementById('btn-registro');
const btnDipendente = document.getElementById('btn-dipendente');
const btnMacchinetta = document.getElementById('btn-macchinetta');
const btnPreferiti = document.getElementById('btn-preferiti');

const displayTotale = document.getElementById('display-totale');
const areaDati = document.getElementById('area-dati-tabella');
const campoSconto = document.getElementById('campo-sconto');
const campoPagamento = document.getElementById('campo-pagamento');
const campoScheda = document.getElementById('campo-scheda');
const campoBarcode = document.getElementById('campo-barcode');
const listaRicerca = document.getElementById('lista-ricerca');
const btnAnnullaSconto = document.getElementById('btn-annulla-sconto');

const barraCentro = document.getElementById('stat-centro');
const barraCliente = document.getElementById('stat-cliente');
const barraDestra = document.getElementById('stat-destra');
const txtArticoli = document.getElementById('txt-articoli');
const txtPezzi = document.getElementById('txt-pezzi');
const cliSemaforo = document.getElementById('cli-semaforo');
const cliNome = document.getElementById('cli-nome');
const cliPunti = document.getElementById('cli-punti');
const cliBonus = document.getElementById('cli-bonus');

let carrello = []; let clienteAttivo = null; let totaleLordo = 0; let totaleNettoAttuale = 0; let percentualeSconto = 0; let indiceRicercaAttivo = -1; let msgDaInviarePlain = ""; let telClienteAttuale = "";

// ==========================================
// 🔒 CONFIGURAZIONE ACCESSO (LOGIN)
// ==========================================
const PIN_ACCESSO = "12345"; // Imposta qui il tuo PIN di sicurezza

// AVVIO
window.onload = async () => {
    // Legge le impostazioni: se è "false", il PIN non è richiesto
    let pinRichiesto = localStorage.getItem('impostazioni_pin_attivo') !== 'false';

    // Controlla se la sessione è sbloccata OPPURE se il PIN è stato disabilitato nelle impostazioni
    if (!pinRichiesto || sessionStorage.getItem('cassa_sbloccata') === 'true') {
        document.getElementById('modal-login').style.display = 'none';
        avviaSistemaBase();
    } else {
        // Forza la visualizzazione del login
        document.getElementById('modal-login').style.display = 'flex';
        setTimeout(() => document.getElementById('login-pin').focus(), 100);
    }

    document.getElementById('login-pin').addEventListener('keypress', function (e) {
        if (e.key === 'Enter') sbloccaApp();
    });
};

// Funzione isolata per avviare i database una volta sbloccata l'app
async function avviaSistemaBase() {
    try {
        await initDB();
        mostraMessaggio("CASSA PRONTA");
        campoBarcode.disabled = false;
        campoScheda.disabled = false;

        // All'avvio, mostra il menu principale (Launcher)
        apriModale('modal-menu-principale');

    } catch (e) {
        console.error("Errore inizializzazione DB", e);
        mostraAvvisoModale("Errore durante l'apertura del Database: " + e);
    }
}

// Verifica del PIN
window.sbloccaApp = function () {
    const inputPin = document.getElementById('login-pin').value;

    if (inputPin === PIN_ACCESSO) {
        // PIN Corretto: Salva in sessione, nascondi modale e avvia
        sessionStorage.setItem('cassa_sbloccata', 'true');
        document.getElementById('modal-login').style.display = 'none';
        document.getElementById('login-pin').value = '';
        avviaSistemaBase();
    } else {
        // PIN Errato: Usa la modale custom (NESSUN ALERT DI SISTEMA!)
        mostraAvvisoModale("<b>PIN ERRATO</b><br>Accesso negato al gestionale.");
        document.getElementById('login-pin').value = '';
        document.getElementById('login-pin').focus();
    }
};

// Funzione per bloccare manualmente la cassa
window.bloccaCassa = function () {
    sessionStorage.removeItem('cassa_sbloccata');
    window.location.reload(); // Ricarica la pagina, forzando la comparsa del login
};

// FUNZIONI MODALI UNIVERSALI
function apriModale(id) { const el = document.getElementById(id); if (el) el.style.display = 'flex'; }
function chiudiModale(id) { const el = document.getElementById(id); if (el) el.style.display = 'none'; }
function mostraAvvisoModale(messaggio) { document.getElementById('msg-avviso').innerHTML = messaggio; apriModale('modal-avviso'); }

// AGGIORNAMENTO SCHERMO
function aggiornaContatori() { txtArticoli.textContent = carrello.length + " ARTICOLI"; let numPezzi = 0; carrello.forEach(p => numPezzi += p.qta); txtPezzi.textContent = numPezzi + " PEZZI"; }
function mostraMessaggio(testo, tipo = "normale") { barraCliente.style.display = 'none'; barraCentro.style.display = 'block'; barraCentro.textContent = testo; if (tipo === "errore") { barraCentro.classList.add('avviso-errore'); } else { barraCentro.classList.remove('avviso-errore'); } }
function aggiornaSchermo() { if (totaleLordo === 0) { displayTotale.value = '€ 0,00'; totaleNettoAttuale = 0; return; } let valoreSconto = totaleLordo * (percentualeSconto / 100); totaleNettoAttuale = totaleLordo - valoreSconto; displayTotale.value = '€ ' + totaleNettoAttuale.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

// INSERIMENTO RAPIDO TOTALE
displayTotale.addEventListener('focus', function () { this.value = ''; this.placeholder = '0,00'; });
displayTotale.addEventListener('blur', function () { aggiornaSchermo(); });
displayTotale.addEventListener('keypress', function (e) {
    if (e.key === 'Enter') {
        e.preventDefault();
        let testoDigitato = this.value.trim().replace(',', '.');
        let importo = parseFloat(testoDigitato);
        if (!isNaN(importo) && importo > 0) {
            let prodManuale = { codice: "MAN-" + Math.floor(Math.random() * 1000000), descrizione: "PRODOTTO MANUALE", giacenza: "-", prezzo: importo, categoria: "PM", tipo: "PZ" };
            aggiungiProdotto(prodManuale);
        } else if (testoDigitato !== '') { mostraAvvisoModale("IMPORTO INSERITO NON VALIDO"); }
        this.blur(); campoBarcode.focus();
    }
});

// 🌟 CALCOLATRICE
let calcCategoriaAttiva = ''; let calcSessionTotal = 0;
const displayNumpad = document.getElementById('display-numpad');
const numpadLogList = document.getElementById('numpad-log-list');
const numpadLogTotale = document.getElementById('numpad-log-totale');

if (btnCalcolatrice) { btnCalcolatrice.addEventListener('click', function () { apriModale('modal-calc-categorie'); }); }

window.apriNumpad = function (categoriaSelezionata) {
    calcCategoriaAttiva = categoriaSelezionata; displayNumpad.value = ''; document.getElementById('titolo-numpad').textContent = "IMPORTO REPARTO " + categoriaSelezionata;
    calcSessionTotal = 0; numpadLogList.innerHTML = ''; numpadLogTotale.textContent = '€ 0,00';
    chiudiModale('modal-calc-categorie'); apriModale('modal-numpad'); setTimeout(() => displayNumpad.focus(), 100);
};

window.digitaNumpad = function (tasto) {
    let valAttuale = displayNumpad.value;
    if (tasto === 'C') { valAttuale = ''; } else if (tasto === ',') { if (!valAttuale.includes(',')) { valAttuale += valAttuale === '' ? '0,' : ','; } } else { if (valAttuale.length < 8) { valAttuale += tasto; } }
    displayNumpad.value = valAttuale; displayNumpad.focus();
};

displayNumpad.addEventListener('input', function () { this.value = this.value.replace(/[^0-9.,]/g, ''); });
displayNumpad.addEventListener('keypress', function (e) { if (e.key === 'Enter') { e.preventDefault(); confermaNumpad(); } });

window.confermaNumpad = function () {
    let testoDigitato = displayNumpad.value.trim().replace(',', '.'); let importo = parseFloat(testoDigitato);
    if (!isNaN(importo) && importo > 0) {
        let prodReparto = { codice: "REP-" + Math.floor(Math.random() * 1000000), descrizione: "REPARTO " + calcCategoriaAttiva, giacenza: "-", prezzo: importo, categoria: calcCategoriaAttiva, tipo: "PZ" };
        aggiungiProdotto(prodReparto);
        calcSessionTotal += importo; numpadLogTotale.textContent = '€ ' + calcSessionTotal.toLocaleString('it-IT', { minimumFractionDigits: 2 });
        let logItem = document.createElement('div'); logItem.className = 'log-item'; logItem.title = "Clicca per annullare l'inserimento";
        logItem.innerHTML = `<span>${calcCategoriaAttiva}</span> <span>€ ${importo.toLocaleString('it-IT', { minimumFractionDigits: 2 })}</span>`;

        logItem.addEventListener('click', function () {
            calcSessionTotal -= importo; if (calcSessionTotal < 0.01) calcSessionTotal = 0; numpadLogTotale.textContent = '€ ' + calcSessionTotal.toLocaleString('it-IT', { minimumFractionDigits: 2 });
            let indexDaEliminare = carrello.findIndex(i => i.codice === prodReparto.codice);
            if (indexDaEliminare > -1) { let item = carrello[indexDaEliminare]; totaleLordo -= item.prezzo; if (totaleLordo < 0.01) totaleLordo = 0; carrello.splice(indexDaEliminare, 1); let rigaMain = document.getElementById('riga-' + prodReparto.codice); if (rigaMain) rigaMain.remove(); aggiornaSchermo(); aggiornaContatori(); }
            this.remove(); displayNumpad.focus();
        });

        numpadLogList.appendChild(logItem); numpadLogList.scrollTop = numpadLogList.scrollHeight; displayNumpad.style.backgroundColor = '#ccffcc'; setTimeout(() => displayNumpad.style.backgroundColor = 'transparent', 200); displayNumpad.value = ''; displayNumpad.focus();
    } else { displayNumpad.style.backgroundColor = '#ffcccc'; setTimeout(() => displayNumpad.style.backgroundColor = 'transparent', 200); }
};

// AGGIUNGI PRODOTTO A CARRELLO E SCHERMO
function aggiungiProdotto(prodotto) {
    let itemInCart = carrello.find(i => i.codice === prodotto.codice);
    if (itemInCart) {
        itemInCart.qta++; const rigaEsistente = document.getElementById('riga-' + prodotto.codice); rigaEsistente.querySelector('.qta-val').textContent = itemInCart.qta; rigaEsistente.querySelector('.tot-riga-val').textContent = '€ ' + (itemInCart.qta * itemInCart.prezzo).toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    } else {
        carrello.push({ ...prodotto, qta: 1 }); const nuovaRiga = document.createElement('div'); nuovaRiga.className = 'riga-prodotto'; nuovaRiga.id = 'riga-' + prodotto.codice; nuovaRiga.title = "Clicca per rimuovere 1 pezzo";
        nuovaRiga.innerHTML = `<div class="col-centro">${prodotto.codice.substring(0, 3) === 'MAN' || prodotto.codice.substring(0, 3) === 'REP' ? '0' : prodotto.codice}</div><div class="col-sinistra">${prodotto.descrizione}</div><div class="col-centro">${prodotto.giacenza}</div><div class="col-valuta">€ ${prodotto.prezzo.toLocaleString('it-IT', { minimumFractionDigits: 2 })}</div><div class="col-centro qta-val">1</div><div class="col-centro">${prodotto.categoria}</div><div class="col-valuta tot-riga-val">€ ${prodotto.prezzo.toLocaleString('it-IT', { minimumFractionDigits: 2 })}</div>`;

        nuovaRiga.addEventListener('click', function () {
            let indexDaEliminare = carrello.findIndex(i => i.codice === prodotto.codice);
            if (indexDaEliminare > -1) {
                let item = carrello[indexDaEliminare]; totaleLordo -= item.prezzo; if (totaleLordo < 0.01) totaleLordo = 0;
                if (item.qta > 1) { item.qta--; this.querySelector('.qta-val').textContent = item.qta; this.querySelector('.tot-riga-val').textContent = '€ ' + (item.qta * item.prezzo).toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); if (barraCliente.style.display !== 'flex') { mostraMessaggio("RIMOSSO 1 PEZZO: " + item.descrizione); } }
                else { carrello.splice(indexDaEliminare, 1); this.remove(); if (barraCliente.style.display !== 'flex') { mostraMessaggio("ARTICOLO RIMOSSO: " + item.descrizione); } }
                aggiornaSchermo(); aggiornaContatori(); if (document.getElementById('modal-numpad').style.display !== 'flex') { campoBarcode.focus(); }
            }
        });
        areaDati.appendChild(nuovaRiga); areaDati.scrollTop = areaDati.scrollHeight;
    }
    totaleLordo += prodotto.prezzo; aggiornaSchermo(); aggiornaContatori(); campoBarcode.value = ''; listaRicerca.style.display = 'none'; indiceRicercaAttivo = -1;
    if (barraCliente.style.display !== 'flex') { mostraMessaggio("INSERITO: " + prodotto.descrizione); }
    if (document.getElementById('modal-numpad').style.display !== 'flex') { campoBarcode.focus(); }
}

// RICERCA CLIENTE
async function eseguiRicercaCliente(valoreInserito) {
    clienteAttivo = await getBySchedaOTelefono(valoreInserito);
    if (clienteAttivo) {
        barraCentro.style.display = 'none'; barraCentro.classList.remove('avviso-errore'); barraCliente.style.display = 'flex';
        cliNome.textContent = clienteAttivo.nome; cliPunti.textContent = clienteAttivo.punti.toLocaleString('it-IT', { maximumFractionDigits: 2 }); cliBonus.textContent = clienteAttivo.bonus.toLocaleString('it-IT', { minimumFractionDigits: 2 });
        const oggi = new Date(); const dataOperazione = new Date(clienteAttivo.dataUltimaOperazione); const differenzaGiorni = Math.floor((oggi - dataOperazione) / (1000 * 60 * 60 * 24));
        if (differenzaGiorni <= 30) { cliSemaforo.textContent = '🟢'; } else if (differenzaGiorni <= 60) { cliSemaforo.textContent = '🟡'; } else { cliSemaforo.textContent = '🔴'; } campoBarcode.focus();
    } else { clienteAttivo = null; mostraAvvisoModale("NESSUN CLIENTE TROVATO CON QUESTO NUMERO O SCHEDA."); }
}

campoScheda.addEventListener('input', function () { this.value = this.value.replace(/[^0-9]/g, ''); if (this.value.length === 10 || this.value.length === 13) { eseguiRicercaCliente(this.value); } else { clienteAttivo = null; if (barraCliente.style.display === 'flex') { mostraMessaggio("CASSA PRONTA"); } } });
campoScheda.addEventListener('keypress', function (e) { if (e.key === 'Enter') { eseguiRicercaCliente(this.value.trim()); } });
campoScheda.addEventListener('mouseenter', function () { this.focus(); }); campoBarcode.addEventListener('mouseenter', function () { this.focus(); });

// ==========================================
// ⭐ MOTORE CALCOLO PUNTI E SOGLIE DINAMICHE
// ==========================================
// 1. Il nuovo calcolatore che legge le regole salvate
function calcolaPuntiSpesa(bonusApplicato = 0) {
    let puntiGuadagnati = 0;

    // Recupera le regole dalla memoria, o usa le storiche di default se è la prima volta
    let regoleSalvate = localStorage.getItem('crm_soglie_punti');
    let regole = regoleSalvate ? JSON.parse(regoleSalvate) : { "CBD": 1, "PM": 1, "HHC": 0.5, "DEFAULT": 0.25 };

    carrello.forEach(item => {
        let prezzoScontatoRiga = (item.prezzo * item.qta) * (1 - percentualeSconto / 100);
        let cat = (item.categoria || "").toUpperCase();

        // Cerca se esiste una regola specifica per questa categoria, altrimenti usa quella DEFAULT
        let moltiplicatore = regole[cat] !== undefined ? parseFloat(regole[cat]) : parseFloat(regole["DEFAULT"]);

        puntiGuadagnati += prezzoScontatoRiga * moltiplicatore;
    });

    if (bonusApplicato > 0 && totaleNettoAttuale > 0) {
        let rapportoNettoSuLordo = (totaleNettoAttuale - bonusApplicato) / totaleNettoAttuale;
        puntiGuadagnati = puntiGuadagnati * rapportoNettoSuLordo;
    }

    return parseFloat(puntiGuadagnati.toFixed(2));
}

// 2. Variabile temporanea per la gestione a schermo
let tempSogliePunti = {};

// 3. Apre il modale e disegna la lista
window.apriGestioneSogliePunti = function () {
    let salvate = localStorage.getItem('crm_soglie_punti');
    tempSogliePunti = salvate ? JSON.parse(salvate) : { "CBD": 1, "PM": 1, "HHC": 0.5, "DEFAULT": 0.25 };

    disegnaListaSogliePunti();
    chiudiModale('modal-impostazioni-menu');
    apriModale('modal-impostazioni-soglie');
};

// 4. Disegna le righe nella tabella
function disegnaListaSogliePunti() {
    let html = "";
    for (let cat in tempSogliePunti) {
        let isDefault = (cat === "DEFAULT");
        let tastoElimina = isDefault ?
            `<span style="color: #666; font-size: 1.2vh;">Fisso</span>` :
            `<button onclick="eliminaSogliaPunti('${cat}')" style="background: rgba(255,77,77,0.2); border: 1px solid #ff4d4d; color: #ff4d4d; border-radius: 4px; cursor: pointer; padding: 2px 8px;">❌</button>`;

        html += `
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid rgba(255,255,255,0.1);">
                <div style="flex: 2; font-weight: bold; color: ${isDefault ? '#b3d9ff' : 'white'};">${isDefault ? 'TUTTO IL RESTO (DEFAULT)' : cat}</div>
                <div style="flex: 1; text-align: center; color: #00ffcc; font-weight: bold;">x ${tempSogliePunti[cat]}</div>
                <div style="flex: 0.5; text-align: right;">${tastoElimina}</div>
            </div>
        `;
    }
    document.getElementById('lista-soglie-punti').innerHTML = html;
}

// 5. Aggiunge o aggiorna una regola
window.aggiungiSogliaPunti = function () {
    let cat = document.getElementById('nuova-soglia-cat').value.trim().toUpperCase();
    let valString = document.getElementById('nuova-soglia-val').value.trim().replace(',', '.');
    let val = parseFloat(valString);

    if (cat === "") {
        mostraAvvisoModale("Inserisci il nome della categoria.");
        return;
    }
    if (isNaN(val) || val < 0) {
        mostraAvvisoModale("Inserisci un moltiplicatore valido (es. 1 o 0.5).");
        return;
    }

    tempSogliePunti[cat] = val; // Aggiunge o sovrascrive
    document.getElementById('nuova-soglia-cat').value = "";
    document.getElementById('nuova-soglia-val').value = "";
    disegnaListaSogliePunti();
};

// 6. Elimina una regola
window.eliminaSogliaPunti = function (cat) {
    if (cat === "DEFAULT") return; // Sicurezza
    delete tempSogliePunti[cat];
    disegnaListaSogliePunti();
};

// 7. Salva permanentemente
window.salvaSogliePunti = function () {
    // Ci assicuriamo che la categoria DEFAULT esista sempre
    if (tempSogliePunti["DEFAULT"] === undefined) tempSogliePunti["DEFAULT"] = 0.25;

    localStorage.setItem('crm_soglie_punti', JSON.stringify(tempSogliePunti));

    mostraAvvisoModale("Soglie punti aggiornate con successo!");
    chiudiModale('modal-impostazioni-soglie');
    apriModale('modal-impostazioni-menu');
};

// TASTO CASSA
if (btnCassa) {
    btnCassa.addEventListener('click', function () {
        // 1. Controllo Scontrino Vuoto
        if (carrello.length === 0) {
            mostraAvvisoModale("SCONTRINO VUOTO.<br>Aggiungi almeno un articolo.");
            return;
        }

        // 2. 🌟 NUOVO CONTROLLO: Tipo di Pagamento Selezionato
        if (campoPagamento.value.trim() === "") {
            mostraAvvisoModale("ATTENZIONE:<br>Seleziona un METODO DI PAGAMENTO (Contanti o POS) prima di chiudere lo scontrino.");
            return;
        }

        // 3. Controllo Bonus Cliente
        if (clienteAttivo && clienteAttivo.bonus > 0) {
            document.getElementById('mod-totale').textContent = '€ ' + totaleNettoAttuale.toLocaleString('it-IT', { minimumFractionDigits: 2 });
            document.getElementById('mod-bonus').textContent = '- € ' + clienteAttivo.bonus.toLocaleString('it-IT', { minimumFractionDigits: 2 });
            let netto = totaleNettoAttuale - clienteAttivo.bonus;
            document.getElementById('mod-netto').textContent = '€ ' + netto.toLocaleString('it-IT', { minimumFractionDigits: 2 });
            apriModale('modal-riscatto');
        } else {
            confermaVendita(false);
        }
    });
}

window.confermaVendita = async function (riscattaBonus) {
    if (riscattaBonus) { if (clienteAttivo.bonus > totaleNettoAttuale) { chiudiModale('modal-riscatto'); apriModale('modal-saldo-negativo'); return; } }
    chiudiModale('modal-riscatto'); let messaggioEsito = ""; let bonusUsato = (riscattaBonus && clienteAttivo) ? clienteAttivo.bonus : 0; let tipoPagamento = campoPagamento.value || "CONTANTI"; let pagato = totaleNettoAttuale - bonusUsato;
    let saldoIniziale = clienteAttivo ? clienteAttivo.punti : 0; let puntiAcquisiti = 0; let puntiSpesi = 0; let saldoFinale = saldoIniziale; let dataDiOggiStr = getOggiString();

    if (clienteAttivo) {
        puntiAcquisiti = calcolaPuntiSpesa(bonusUsato); let puntiString = puntiAcquisiti.toLocaleString('it-IT', { maximumFractionDigits: 2 }); let baseSpesaPagata = pagato;
        if (riscattaBonus) {
            puntiSpesi = clienteAttivo.bonus * 10; clienteAttivo.punti -= puntiSpesi; clienteAttivo.punti += puntiAcquisiti; clienteAttivo.bonus = Math.floor(clienteAttivo.punti / 100) * 10; clienteAttivo.dataUltimaOperazione = dataDiOggiStr; saldoFinale = clienteAttivo.punti;
            messaggioEsito = `Scontrino emesso riscattando il bonus.<br><br>Punti spesi per il premio: <b style="color:#ff6666;">⭐ -${puntiSpesi}</b><br>Punti guadagnati su € ${baseSpesaPagata.toLocaleString('it-IT', { minimumFractionDigits: 2 })} pagati: <b style="color:#00cc66;">⭐ +${puntiString}</b><br><br>Nuovo saldo punti: <b>⭐ ${clienteAttivo.punti.toLocaleString('it-IT', { maximumFractionDigits: 2 })}</b><br>Nuovo Bonus disponibile: <b>🎁 € ${clienteAttivo.bonus}</b>`;
        } else {
            clienteAttivo.punti += puntiAcquisiti; clienteAttivo.bonus = Math.floor(clienteAttivo.punti / 100) * 10; clienteAttivo.dataUltimaOperazione = dataDiOggiStr; saldoFinale = clienteAttivo.punti;
            messaggioEsito = `Scontrino emesso senza usare il bonus.<br><br>Punti guadagnati su questa spesa: <b style="color:#00cc66;">⭐ +${puntiString}</b><br><br>Nuovo saldo punti: <b>⭐ ${clienteAttivo.punti.toLocaleString('it-IT', { maximumFractionDigits: 2 })}</b><br>Bonus disponibile per la prossima spesa: <b>🎁 € ${clienteAttivo.bonus}</b>`;
        }
        await updateCliente(clienteAttivo);

        // 🔥 SINCRONIZZAZIONE FIREBASE
        // 1. Aggiorna sempre il saldo punti totale su Firebase in background
        aggiornaFidelityFirebase(clienteAttivo.scheda, clienteAttivo.punti, dataDiOggiStr);

        // 2. Prepara i dati della notifica e lasciali in attesa che l'operatore clicchi il tasto
        window.datiNotificaApp = {
            scheda: clienteAttivo.scheda,
            saldoIniziale: saldoIniziale,
            puntiAcquisiti: puntiAcquisiti,
            puntiSpesi: puntiSpesi,
            saldoFinale: saldoFinale,
            bonus: clienteAttivo.bonus
        };

        telClienteAttuale = clienteAttivo.telefono;

        // Leggi il template dalle impostazioni
        let templateMsg = localStorage.getItem('impostazioni_msg_template') || MSG_BASE_DEFAULT;

        // 1. Formatta tutti i valori numerici con 2 decimali fissi (es. 75,00)
        let strSaldoIniziale = saldoIniziale.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        let strPuntiCaricati = puntiAcquisiti.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        let strPuntiScaricati = puntiSpesi.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        let strPuntiFinale = clienteAttivo.punti.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        let strBonus = clienteAttivo.bonus.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

        // 2. Calcola Data e Ora correnti
        let dataOggiTs = new Date();
        let strData = `${String(dataOggiTs.getDate()).padStart(2, '0')}/${String(dataOggiTs.getMonth() + 1).padStart(2, '0')}/${dataOggiTs.getFullYear()}`;
        let strOra = `${String(dataOggiTs.getHours()).padStart(2, '0')}:${String(dataOggiTs.getMinutes()).padStart(2, '0')}:${String(dataOggiTs.getSeconds()).padStart(2, '0')}`;

        // 3. Sostituisci tutte le variabili nel template
        msgDaInviarePlain = templateMsg
            .replace(/{NOME}/g, clienteAttivo.nome)
            .replace(/{SCHEDA}/g, clienteAttivo.scheda)
            .replace(/{SALDO_INIZIALE}/g, strSaldoIniziale)
            .replace(/{PUNTI_CARICATI}/g, strPuntiCaricati)
            .replace(/{PUNTI_SCARICATI}/g, strPuntiScaricati)
            .replace(/{PUNTI}/g, strPuntiFinale)
            .replace(/{BONUS}/g, strBonus)
            .replace(/{DATA}/g, strData)
            .replace(/{ORA}/g, strOra);

        document.getElementById('box-notifiche').style.display = 'block';
        let btnApp = document.getElementById('btn-invia-app');
        btnApp.innerHTML = '📱 Notifica App';
        btnApp.classList.remove('inviato');
    } else {
        messaggioEsito = "Scontrino emesso per cliente non registrato.";
        document.getElementById('box-notifiche').style.display = 'none';
    }

    let d = new Date(); let hh = String(d.getHours()).padStart(2, '0'); let min = String(d.getMinutes()).padStart(2, '0');

    // 🌟 QUI AVVIENE LA MODIFICA: Inserimento del parametro OPERATORE
    let recordVendita = {
        id: Date.now(),
        CLIENTE: clienteAttivo ? clienteAttivo.nome : "Nessuno",
        OPERATORE: operatoreAttivo,
        GIORNO: dataDiOggiStr,
        ORA: `${hh}:${min}`,
        CONTANTI: tipoPagamento.toUpperCase() === "CONTANTI" ? pagato : 0,
        POS: tipoPagamento.toUpperCase() === "POS" ? pagato : 0,
        PUNTI_CARICATI: puntiAcquisiti,
        PUNTI_SCARICATI: puntiSpesi,
        BONUS: bonusUsato,
        SALDO_PUNTI_INIZIALE: saldoIniziale,
        SALDO_PUNTI_FINALE: saldoFinale,
        ARTICOLI: carrello.map(item => ({
            CODICE: item.codice,
            ARTICOLO: item.descrizione,
            DESCRIZIONE: item.descrizione,
            TIPO: item.tipo || "PZ",
            IMPORTO: item.prezzo * item.qta,
            QUANTITA: item.qta,
            CATEGORIA: item.categoria
        }))
    };

    await salvaVendita(recordVendita);

    // 🔥 TRASMISSIONE AL CRUSCOTTO DIREZIONALE
    inviaVenditaLive(recordVendita);

    document.getElementById('msg-esito-punti').innerHTML = messaggioEsito;
    apriModale('modal-esito');
};

window.inviaWhatsApp = function () {
    if (!telClienteAttuale) return;
    // Usa il protocollo nativo whatsapp://
    window.location.href = `whatsapp://send?phone=39${telClienteAttuale}&text=${encodeURIComponent(msgDaInviarePlain)}`;
};

window.inviaTelegram = function () {
    if (!telClienteAttuale) return;
    // Usa il protocollo nativo tg://
    window.location.href = `tg://msg?to=+39${telClienteAttuale}&text=${encodeURIComponent(msgDaInviarePlain)}`;
};

window.inviaApp = async function () {
    let btn = document.getElementById('btn-invia-app');
    if (btn.classList.contains('inviato')) return;

    btn.innerHTML = '⏳ Invio in corso...';

    // Invia fisicamente i dati a Firebase
    if (window.datiNotificaApp) {
        await firebasePushNotifiche(
            window.datiNotificaApp.scheda,
            window.datiNotificaApp.saldoIniziale,
            window.datiNotificaApp.puntiAcquisiti,
            window.datiNotificaApp.puntiSpesi,
            window.datiNotificaApp.saldoFinale,
            window.datiNotificaApp.bonus
        );
    }

    btn.innerHTML = '✅ Inviato con successo';
    btn.classList.add('inviato');
};
window.chiudiModaleEsito = function () { chiudiModale('modal-esito'); if (btnCestino) btnCestino.click(); }

// RICERCA PRODOTTO DB
campoBarcode.addEventListener('input', async function () { const testo = this.value.toLowerCase().trim(); listaRicerca.innerHTML = ''; indiceRicercaAttivo = -1; if (testo.length < 2) { listaRicerca.style.display = 'none'; return; } const magazzinoCompleto = await getAll('magazzino'); const risultati = magazzinoCompleto.filter(p => p.codice.toLowerCase().includes(testo) || p.descrizione.toLowerCase().includes(testo)); if (risultati.length > 0) { listaRicerca.style.display = 'flex'; risultati.forEach(p => { const div = document.createElement('div'); div.className = 'voce-lista'; div.textContent = `${p.codice} - ${p.descrizione} (€ ${p.prezzo.toLocaleString('it-IT', { minimumFractionDigits: 2 })})`; div.addEventListener('click', () => aggiungiProdotto(p)); listaRicerca.appendChild(div); }); } else { listaRicerca.style.display = 'none'; } });
campoBarcode.addEventListener('keydown', async function (e) { let elementi = listaRicerca.querySelectorAll('.voce-lista'); if (listaRicerca.style.display === 'none' || elementi.length === 0) { if (e.key === 'Enter') { e.preventDefault(); const codice = this.value.trim(); const magazzinoCompleto = await getAll('magazzino'); const prodotto = magazzinoCompleto.find(p => p.codice === codice); if (prodotto) { aggiungiProdotto(prodotto); } else if (codice.length > 0) { mostraAvvisoModale("PRODOTTO NON TROVATO A MAGAZZINO"); this.value = ''; } } return; } if (e.key === 'ArrowDown') { e.preventDefault(); indiceRicercaAttivo++; if (indiceRicercaAttivo >= elementi.length) indiceRicercaAttivo = 0; evidenziaVoce(elementi); } else if (e.key === 'ArrowUp') { e.preventDefault(); indiceRicercaAttivo--; if (indiceRicercaAttivo < 0) indiceRicercaAttivo = elementi.length - 1; evidenziaVoce(elementi); } else if (e.key === 'Enter') { e.preventDefault(); if (indiceRicercaAttivo > -1) elementi[indiceRicercaAttivo].click(); } });
function evidenziaVoce(elementi) { elementi.forEach(el => el.classList.remove('voce-evidenziata')); if (indiceRicercaAttivo > -1) { elementi[indiceRicercaAttivo].classList.add('voce-evidenziata'); elementi[indiceRicercaAttivo].scrollIntoView({ block: "nearest" }); } }

document.querySelectorAll('.opt-sconto').forEach(opt => { opt.addEventListener('click', function () { percentualeSconto = parseInt(this.getAttribute('data-sconto')); campoSconto.value = "- " + percentualeSconto + "%"; campoSconto.style.color = "#cc0000"; btnAnnullaSconto.style.display = "block"; aggiornaSchermo(); }); }); btnAnnullaSconto.addEventListener('click', function () { percentualeSconto = 0; campoSconto.value = ""; campoSconto.style.color = "#000033"; this.style.display = "none"; aggiornaSchermo(); }); document.querySelectorAll('.opt-pagamento').forEach(opt => { opt.addEventListener('click', function () { campoPagamento.value = this.textContent; barraDestra.textContent = this.getAttribute('data-icona'); }); });

if (btnCestino) { btnCestino.addEventListener('click', function () { areaDati.innerHTML = ''; carrello = []; clienteAttivo = null; totaleLordo = 0; totaleNettoAttuale = 0; percentualeSconto = 0; campoSconto.value = ''; campoSconto.style.color = "#000033"; btnAnnullaSconto.style.display = "none"; campoPagamento.value = ''; campoScheda.value = ''; campoBarcode.value = ''; barraDestra.textContent = ''; listaRicerca.style.display = 'none'; barraCliente.style.display = 'none'; barraCentro.style.display = 'block'; mostraMessaggio("CASSA PRONTA"); aggiornaSchermo(); aggiornaContatori(); campoBarcode.focus(); }); }


// 🌟 GESTIONE PREFERITI (PUNTI MANUALI)
const inPuntiCliente = document.getElementById('man-punti-cliente'); const inPuntiValore = document.getElementById('man-punti-valore'); const inPuntiData = document.getElementById('man-punti-data'); const boxManInfo = document.getElementById('man-info-box'); const lblManNome = document.getElementById('man-info-nome'); const lblManPunti = document.getElementById('man-info-punti'); const lblManBonus = document.getElementById('man-info-bonus');
let clienteManualeScelto = null;

if (btnPreferiti) {
    btnPreferiti.addEventListener('click', function () {
        inPuntiCliente.value = ''; inPuntiValore.value = ''; inPuntiData.value = getOggiString(); boxManInfo.style.display = 'none'; clienteManualeScelto = null;
        apriModale('modal-punti-manuali'); setTimeout(() => inPuntiCliente.focus(), 100);
    });
}

window.incollaTelefonoPunti = function () {
    if (campoScheda.value !== '') { inPuntiCliente.value = campoScheda.value; cercaClientePerPuntiManuali(campoScheda.value); }
};

if (inPuntiCliente) {
    inPuntiCliente.addEventListener('input', function () {
        this.value = this.value.replace(/[^0-9]/g, '');
        if (this.value.length === 10 || this.value.length === 13) { cercaClientePerPuntiManuali(this.value); } else { boxManInfo.style.display = 'none'; clienteManualeScelto = null; inPuntiCliente.style.backgroundColor = '#ffffff'; }
    });
}

async function cercaClientePerPuntiManuali(valore) {
    let c = await getBySchedaOTelefono(valore);
    if (c) {
        clienteManualeScelto = c; lblManNome.textContent = c.nome; lblManPunti.textContent = c.punti.toLocaleString('it-IT', { maximumFractionDigits: 2 }); lblManBonus.textContent = "€ " + c.bonus.toLocaleString('it-IT', { minimumFractionDigits: 2 }); boxManInfo.style.display = 'block'; inPuntiCliente.style.backgroundColor = '#ccffcc'; inPuntiValore.focus();
    } else { inPuntiCliente.style.backgroundColor = '#ffcccc'; boxManInfo.style.display = 'none'; clienteManualeScelto = null; }
}

window.applicaPuntiManuali = async function (azione) {
    let valoreString = inPuntiValore.value.trim().replace(',', '.'); let puntiDaverificare = parseFloat(valoreString);
    if (!clienteManualeScelto) { mostraAvvisoModale("Seleziona prima un cliente valido!"); return; }
    if (isNaN(puntiDaverificare) || puntiDaverificare <= 0) { mostraAvvisoModale("Inserisci una quantità di punti valida!"); return; }
    if (!inPuntiData.value) { mostraAvvisoModale("Seleziona una data!"); return; }

    let puntiDaApplicare = azione === 'SOTTRAI' ? puntiDaverificare * -1 : puntiDaverificare;
    if (azione === 'SOTTRAI' && (clienteManualeScelto.punti + puntiDaApplicare) < 0) { mostraAvvisoModale("Il cliente non ha abbastanza punti da scaricare!"); return; }

    clienteManualeScelto.punti += puntiDaApplicare; clienteManualeScelto.bonus = Math.floor(clienteManualeScelto.punti / 100) * 10; clienteManualeScelto.dataUltimaOperazione = inPuntiData.value;
    await updateCliente(clienteManualeScelto);

    // 🔥 SINCRONIZZAZIONE FIREBASE (Punti Manuali)
    let puntiCaric = azione === 'CARICA' ? puntiDaverificare : 0;
    let puntiScaric = azione === 'SOTTRAI' ? puntiDaverificare : 0;
    let saldoIniz = clienteManualeScelto.punti - puntiDaApplicare;

    aggiornaFidelityFirebase(clienteManualeScelto.scheda, clienteManualeScelto.punti, inPuntiData.value);
    firebasePushNotifiche(clienteManualeScelto.scheda, saldoIniz, puntiCaric, puntiScaric, clienteManualeScelto.punti, clienteManualeScelto.bonus);

    let d = new Date();
    let recordPunti = { CLIENTE: clienteManualeScelto.nome, GIORNO: inPuntiData.value, ORA: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`, CONTANTI: 0, POS: 0, PUNTI_CARICATI: azione === 'CARICA' ? puntiDaverificare : 0, PUNTI_SCARICATI: azione === 'SOTTRAI' ? puntiDaverificare : 0, BONUS: 0, SALDO_PUNTI_INIZIALE: clienteManualeScelto.punti - puntiDaApplicare, SALDO_PUNTI_FINALE: clienteManualeScelto.punti, ARTICOLI: [{ CODICE: "PUNTI", ARTICOLO: "MOVIMENTO MANUALE PUNTI", DESCRIZIONE: azione, TIPO: "PTS", IMPORTO: 0, QUANTITA: 1, CATEGORIA: "SISTEMA" }] };
    await salvaVendita(recordPunti);
    chiudiModale('modal-punti-manuali'); mostraMessaggio(`✅ ${azione} PUNTI COMPLETATA PER ${clienteManualeScelto.nome}`);
};


// 🌟 GESTIONE CLIENTI CRM E CONTROLLI
const inputCrmScheda = document.getElementById('crm-codice'); const inputCrmNome = document.getElementById('crm-nome'); const inputCrmTel = document.getElementById('crm-telefono'); const inputCrmPunti = document.getElementById('crm-punti'); const lblCrmBonus = document.getElementById('crm-calc-bonus'); const lblCrmData = document.getElementById('crm-calc-data'); const btnCrmElimina = document.getElementById('crm-btn-elimina'); const btnGeneraScheda = document.getElementById('btn-genera-scheda'); const listaCrmHTML = document.getElementById('crm-list'); const searchCrm = document.getElementById('crm-search');
let listaClientiCompleta = [];

if (btnClienti) { btnClienti.addEventListener('click', async function () { apriModale('modal-gestione-clienti'); await crmCaricaLista(); crmNuovoCliente(); searchCrm.value = ''; searchCrm.focus(); }); }

async function crmCaricaLista() { listaClientiCompleta = await getAll('clienti'); listaClientiCompleta.sort((a, b) => a.nome.localeCompare(b.nome)); crmDisegnaLista(listaClientiCompleta); }

function crmDisegnaLista(arrayClienti) {
    listaCrmHTML.innerHTML = '';
    arrayClienti.forEach(c => {
        let div = document.createElement('div'); div.className = 'crm-list-item';
        div.innerHTML = `<div class="crm-list-nome">${c.nome}</div><div class="crm-list-dati"><span>📞 ${c.telefono}</span> <span>⭐ ${c.punti.toLocaleString('it-IT', { maximumFractionDigits: 2 })}</span></div>`;
        div.addEventListener('click', () => { document.querySelectorAll('.crm-list-item').forEach(el => el.classList.remove('attivo')); div.classList.add('attivo'); crmCaricaScheda(c); });
        listaCrmHTML.appendChild(div);
    });
}

if (searchCrm) {
    searchCrm.addEventListener('input', function () { let t = this.value.toLowerCase().trim(); if (t === '') { crmDisegnaLista(listaClientiCompleta); return; } let filtrati = listaClientiCompleta.filter(c => c.nome.toLowerCase().includes(t) || c.telefono.includes(t) || c.scheda.includes(t)); crmDisegnaLista(filtrati); });
}

function crmCaricaScheda(c) { document.getElementById('crm-titolo-scheda').textContent = "MODIFICA CLIENTE"; inputCrmScheda.value = c.scheda; inputCrmScheda.disabled = true; btnGeneraScheda.style.display = 'none'; inputCrmNome.value = c.nome; inputCrmTel.value = c.telefono; inputCrmPunti.value = c.punti.toLocaleString('it-IT', { maximumFractionDigits: 2 }); lblCrmBonus.textContent = "€ " + c.bonus; if (c.dataUltimaOperazione) { let partiData = c.dataUltimaOperazione.split('-'); if (partiData.length === 3) { lblCrmData.textContent = `${partiData[2]}/${partiData[1]}/${partiData[0]}`; } else { lblCrmData.textContent = c.dataUltimaOperazione; } } else { lblCrmData.textContent = "-"; } btnCrmElimina.style.display = 'block'; }
window.crmNuovoCliente = function () { document.getElementById('crm-titolo-scheda').textContent = "NUOVO CLIENTE"; inputCrmScheda.value = ''; inputCrmScheda.disabled = false; btnGeneraScheda.style.display = 'block'; inputCrmNome.value = ''; inputCrmTel.value = ''; inputCrmPunti.value = '0'; lblCrmBonus.textContent = "€ 0"; lblCrmData.textContent = "-"; btnCrmElimina.style.display = 'none'; document.querySelectorAll('.crm-list-item').forEach(el => el.classList.remove('attivo')); inputCrmScheda.focus(); };
window.generaCodiceSchedaUnivoco = async function () { let unico = false; let nuovoCodice = ""; btnGeneraScheda.innerHTML = "⏳..."; while (!unico) { let cifreRandom = Math.floor(Math.random() * 10000000000).toString().padStart(10, '0'); nuovoCodice = "200" + cifreRandom; let esiste = await getBySchedaOTelefono(nuovoCodice); if (!esiste) { unico = true; } } inputCrmScheda.value = nuovoCodice; btnGeneraScheda.innerHTML = "🎲 GENERA"; inputCrmTel.focus(); };
if (inputCrmPunti) {
    inputCrmPunti.addEventListener('input', function () { this.value = this.value.replace(/[^0-9.,]/g, ''); let p = parseFloat(this.value.replace(',', '.')); if (!isNaN(p)) { lblCrmBonus.textContent = "€ " + (Math.floor(p / 100) * 10); } });
}

window.crmSalvaCliente = async function () {
    let scheda = inputCrmScheda.value.trim(); let nome = inputCrmNome.value.trim().toUpperCase(); let telefono = inputCrmTel.value.trim(); let punti = parseFloat(inputCrmPunti.value.replace(',', '.')) || 0;
    if (scheda === '' || nome === '' || telefono === '') { mostraAvvisoModale("Compila i campi obbligatori:<br>- Codice Scheda<br>- Nome Completo<br>- Numero di Telefono"); return; }
    let tuttiClienti = await getAll('clienti');
    if (!inputCrmScheda.disabled) { let checkScheda = tuttiClienti.find(c => c.scheda === scheda); if (checkScheda) { mostraAvvisoModale(`Esiste già un cliente registrato con questo Codice Scheda:<br><br><b>${checkScheda.nome}</b>`); return; } }
    let checkTelefono = tuttiClienti.find(c => c.telefono === telefono && c.scheda !== scheda);
    if (checkTelefono) { mostraAvvisoModale(`Il numero di telefono <b>${telefono}</b><br>è già associato al cliente:<br><br><b>${checkTelefono.nome}</b>`); return; }

    let bonusCalcolato = Math.floor(punti / 100) * 10; let dataOp;
    if (lblCrmData.textContent === "-") { dataOp = getOggiString(); } else { let parti = lblCrmData.textContent.split('/'); if (parti.length === 3) { dataOp = `${parti[2]}-${parti[1]}-${parti[0]}`; } else { dataOp = getOggiString(); } }

    let nuovoCliente = { scheda: scheda, nome: nome, telefono: telefono, punti: punti, bonus: bonusCalcolato, dataUltimaOperazione: dataOp };
    await updateCliente(nuovoCliente); document.getElementById('crm-titolo-scheda').textContent = "✅ SALVATO!"; document.getElementById('crm-titolo-scheda').style.color = "#00ff00";
    setTimeout(() => { document.getElementById('crm-titolo-scheda').textContent = "MODIFICA CLIENTE"; document.getElementById('crm-titolo-scheda').style.color = "white"; }, 1500);
    await crmCaricaLista(); inputCrmScheda.disabled = true; btnGeneraScheda.style.display = 'none'; btnCrmElimina.style.display = 'block';
};

window.confermaEliminazioneCliente = function () { let scheda = inputCrmScheda.value.trim(); if (scheda === '') return; apriModale('modal-conferma-elimina'); };

// ============================================
// 🗑️ SISTEMA UNIVERSALE ELIMINAZIONE / STORNO
// ============================================
let idDaEliminare = "";
let tipoEliminazione = ""; // 'CLIENTE', 'PRODOTTO', o 'SCONTRINO'

window.confermaEliminazioneCliente = function () {
    idDaEliminare = document.getElementById('crm-codice').value.trim();
    tipoEliminazione = 'CLIENTE';
    if (idDaEliminare === '') return;
    document.getElementById('msg-conferma-elimina').innerHTML = "Sei sicuro di voler ELIMINARE DEFINITIVAMENTE questo cliente?";
    apriModale('modal-conferma-elimina');
};

window.confermaEliminazioneMagazzino = function () {
    idDaEliminare = document.getElementById('mag-codice').value.trim();
    tipoEliminazione = 'PRODOTTO';
    if (idDaEliminare === '') return;
    document.getElementById('msg-conferma-elimina').innerHTML = "Sei sicuro di voler ELIMINARE DEFINITIVAMENTE questo articolo dal magazzino?";
    apriModale('modal-conferma-elimina');
};

window.confermaAnnullamentoScontrino = function (idScontrino) {
    idDaEliminare = idScontrino;
    tipoEliminazione = 'SCONTRINO';
    document.getElementById('msg-conferma-elimina').innerHTML = "Sei sicuro di voler <b>ANNULLARE</b> questo scontrino?<br><br><span style='color:#b3d9ff;'>I prodotti verranno reinseriti in magazzino e i punti stornati dalla scheda del cliente.</span>";
    apriModale('modal-conferma-elimina');
};

window.confermaAnnullamentoMovimento = function (idMovimento, tipo) {
    idDaEliminare = idMovimento;
    tipoEliminazione = 'MOVIMENTO';
    let nomeOperazione = tipo === 'ENTRATA' ? 'questo INCASSO EXTRA' : 'questa SPESA';
    document.getElementById('msg-conferma-elimina').innerHTML = `Sei sicuro di voler <b>ELIMINARE</b> ${nomeOperazione} dal registro di cassa?`;
    apriModale('modal-conferma-elimina');
};

// Funzione isolata per gestire il ricarico nel database IndexedDB
function ripristinaGiacenzeMagazzino(articoli) {
    return new Promise((resolve) => {
        let txMag = db.transaction('magazzino', 'readwrite');
        let storeMag = txMag.objectStore('magazzino');
        articoli.forEach(art => {
            if (art.CODICE !== 'PUNTI') { // Ignora i movimenti manuali dei punti
                let req = storeMag.get(art.CODICE);
                req.onsuccess = function () {
                    if (req.result) {
                        req.result.giacenza += art.QUANTITA;
                        storeMag.put(req.result);
                    }
                }
            }
        });
        txMag.oncomplete = () => resolve();
    });
}

window.eseguiEliminazioneUniversale = async function () {
    chiudiModale('modal-conferma-elimina');

    if (tipoEliminazione === 'CLIENTE') {
        await deleteRecord('clienti', idDaEliminare);

        // 🔥 CLOUD-SYNC: Elimina definitivamente anche dal Cloud
        if (navigator.onLine) fetch(`${FIREBASE_URL}/clienti/${idDaEliminare}.json`, { method: 'DELETE' }).catch(e => console.log(e));

        crmNuovoCliente();
        await crmCaricaLista();
        mostraMessaggio("CLIENTE ELIMINATO");

    } else if (tipoEliminazione === 'PRODOTTO') {
        await deleteRecord('magazzino', idDaEliminare);

        // 🔥 CLOUD-SYNC: Elimina definitivamente anche dal Cloud
        if (navigator.onLine) fetch(`${FIREBASE_URL}/magazzino/${idDaEliminare}.json`, { method: 'DELETE' }).catch(e => console.log(e));

        magNuovoProdotto();
        await magCaricaLista();
        mostraMessaggio("PRODOTTO ELIMINATO");

    } else if (tipoEliminazione === 'SCONTRINO') {
        let scontrino = await getRecordById('vendite', idDaEliminare);

        if (scontrino) {
            // 1. Rollback Magazzino
            if (scontrino.ARTICOLI && scontrino.ARTICOLI.length > 0) {
                await ripristinaGiacenzeMagazzino(scontrino.ARTICOLI);
            }

            // 2. Rollback Cliente
            if (scontrino.CLIENTE !== "Nessuno") {
                let tuttiClienti = await getAll('clienti');
                // Cerca il cliente tramite il nome esatto salvato nello scontrino
                let cliente = tuttiClienti.find(c => c.nome === scontrino.CLIENTE);

                if (cliente) {
                    cliente.punti -= (scontrino.PUNTI_CARICATI || 0);
                    cliente.punti += (scontrino.PUNTI_SCARICATI || 0); // Restituisce i punti spesi per il bonus!
                    cliente.bonus = Math.floor(cliente.punti / 100) * 10;
                    await updateCliente(cliente);

                    // Aggiorna in tempo reale anche Firebase
                    aggiornaFidelityFirebase(cliente.scheda, cliente.punti, getOggiString());
                }
            }

            // 3. Eliminazione scontrino e aggiornamento visivo
            await deleteRecord('vendite', idDaEliminare);

            // 🔥 RIMUOVE L'INCASSO DAL CRUSCOTTO DIREZIONALE
            eliminaVenditaLive(scontrino.GIORNO, idDaEliminare);

            await popolaRegistroCassa(); // Ricarica il registro di cassa pulito
            mostraMessaggio("SCONTRINO ANNULLATO CON SUCCESSO");
        }
    } else if (tipoEliminazione === 'MOVIMENTO') {
        await deleteRecord('movimenti_cassa', idDaEliminare);
        await popolaRegistroCassa(); // Ricarica il registro aggiornando i totali
        mostraMessaggio("MOVIMENTO ELIMINATO CON SUCCESSO");
    }
};

// 🌟 REGISTRO CASSA E MOVIMENTI
if (btnRegistro) { btnRegistro.addEventListener('click', async function () { await popolaRegistroCassa(); apriModale('modal-registro-cassa'); }); }

async function popolaRegistroCassa() {
    let dataDiOggiStr = getOggiString();
    let venditeOggi = await getByDate('vendite', 'giorno', dataDiOggiStr); let movimentiOggi = await getByDate('movimenti_cassa', 'data', dataDiOggiStr);
    let totPOS = 0; let totContantiVendite = 0; let totEntrateExtra = 0; let totUscite = 0; let numeroScontrini = venditeOggi.length; let listaHtml = "";

    venditeOggi.forEach(v => {
        totPOS += v.POS;
        totContantiVendite += v.CONTANTI;
        let totScontrino = v.POS + v.CONTANTI;

        listaHtml += `
                    <div class="reg-item vendita" style="align-items: center;">
                        <div class="reg-item-ora">${v.ORA}</div>
                        <div class="reg-item-desc">Scontrino ${v.CLIENTE !== "Nessuno" ? " - " + v.CLIENTE : ""}</div>
                        <div class="reg-item-val" style="color:#4d88ff; margin-right: 15px;">+ € ${totScontrino.toLocaleString('it-IT', { minimumFractionDigits: 2 })}</div>
                        <div style="display: flex; gap: 8px;">
                            <button onclick="visualizzaScontrinoDaRegistro(${v.id})" style="background: rgba(77,136,255,0.2); border: 1px solid #4d88ff; color: #b3d9ff; border-radius: 4px; padding: 4px 8px; cursor: pointer; font-size: 1.6vh;" title="Vedi Dettaglio">👁️</button>
                            <button onclick="confermaAnnullamentoScontrino(${v.id})" style="background: rgba(255,77,77,0.2); border: 1px solid #ff4d4d; color: #ff4d4d; border-radius: 4px; padding: 4px 8px; cursor: pointer; font-size: 1.6vh;" title="Annulla Scontrino">❌</button>
                        </div>
                    </div>`;
    });
    movimentiOggi.forEach(m => {
        if (m.tipo === 'ENTRATA') {
            totEntrateExtra += m.importo;
            listaHtml += `
                        <div class="reg-item entrata" style="align-items: center;">
                            <div class="reg-item-ora">${m.ora}</div>
                            <div class="reg-item-desc">${m.descrizione}</div>
                            <div class="reg-item-val verde" style="margin-right: 15px;">+ € ${m.importo.toLocaleString('it-IT', { minimumFractionDigits: 2 })}</div>
                            <button onclick="confermaAnnullamentoMovimento(${m.id}, 'ENTRATA')" style="background: rgba(255,77,77,0.2); border: 1px solid #ff4d4d; color: #ff4d4d; border-radius: 4px; padding: 4px 8px; cursor: pointer; font-size: 1.6vh;" title="Elimina Entrata">❌</button>
                        </div>`;
        } else if (m.tipo === 'USCITA') {
            totUscite += m.importo;
            listaHtml += `
                        <div class="reg-item uscita" style="align-items: center;">
                            <div class="reg-item-ora">${m.ora}</div>
                            <div class="reg-item-desc">${m.descrizione}</div>
                            <div class="reg-item-val rosso" style="margin-right: 15px;">- € ${m.importo.toLocaleString('it-IT', { minimumFractionDigits: 2 })}</div>
                            <button onclick="confermaAnnullamentoMovimento(${m.id}, 'USCITA')" style="background: rgba(255,77,77,0.2); border: 1px solid #ff4d4d; color: #ff4d4d; border-radius: 4px; padding: 4px 8px; cursor: pointer; font-size: 1.6vh;" title="Elimina Spesa">❌</button>
                        </div>`;
        }
    });

    let saldoCassetto = totContantiVendite + totEntrateExtra - totUscite;
    document.getElementById('reg-num-scontrini').textContent = numeroScontrini; document.getElementById('reg-tot-pos').textContent = "€ " + totPOS.toLocaleString('it-IT', { minimumFractionDigits: 2 }); document.getElementById('reg-tot-contanti').textContent = "€ " + totContantiVendite.toLocaleString('it-IT', { minimumFractionDigits: 2 }); document.getElementById('reg-tot-entrate').textContent = "€ " + totEntrateExtra.toLocaleString('it-IT', { minimumFractionDigits: 2 }); document.getElementById('reg-tot-uscite').textContent = "€ " + totUscite.toLocaleString('it-IT', { minimumFractionDigits: 2 }); document.getElementById('reg-saldo-cassetto').textContent = "€ " + saldoCassetto.toLocaleString('it-IT', { minimumFractionDigits: 2 });
    if (listaHtml === "") listaHtml = "<div style='text-align:center; padding:20px; color:#8888bb;'>Nessun movimento registrato oggi.</div>"; document.getElementById('reg-lista-movimenti').innerHTML = listaHtml;
}

if (btnDipendente) {
    btnDipendente.addEventListener('click', () => { document.getElementById('spesa-data').value = getOggiString(); document.getElementById('spesa-importo').value = ''; document.getElementById('spesa-descrizione').value = ''; apriModale('modal-spesa'); setTimeout(() => document.getElementById('spesa-importo').focus(), 100); });
}

if (btnMacchinetta) {
    btnMacchinetta.addEventListener('click', () => { document.getElementById('distributore-data').value = getOggiString(); document.getElementById('distributore-importo').value = ''; apriModale('modal-distributore'); setTimeout(() => document.getElementById('distributore-importo').focus(), 100); });
}

const spesaImp = document.getElementById('spesa-importo'); if (spesaImp) { spesaImp.addEventListener('input', function () { this.value = this.value.replace(/[^0-9.,]/g, ''); }); }
const distImp = document.getElementById('distributore-importo'); if (distImp) { distImp.addEventListener('input', function () { this.value = this.value.replace(/[^0-9.,]/g, ''); }); }

window.salvaSpesa = async function () {
    let impString = document.getElementById('spesa-importo').value.trim().replace(',', '.'); let importo = parseFloat(impString); let desc = document.getElementById('spesa-descrizione').value.trim() || "Uscita generica"; let dataSelezionata = document.getElementById('spesa-data').value;
    if (isNaN(importo) || importo <= 0) { mostraAvvisoModale("Inserisci un importo valido!"); return; } if (!dataSelezionata) { mostraAvvisoModale("Seleziona una data valida!"); return; }
    let d = new Date(); let hh = String(d.getHours()).padStart(2, '0'); let min = String(d.getMinutes()).padStart(2, '0');
    let nuovoMovimento = { data: dataSelezionata, ora: `${hh}:${min}`, tipo: "USCITA", importo: importo, descrizione: desc };

    // Salva nel PC e recupera l'ID
    nuovoMovimento.id = await salvaMovimentoCassaDB(nuovoMovimento);

    // 🔥 INVIA AL CRUSCOTTO FIREBASE
    if (typeof inviaMovimentoLive === "function") inviaMovimentoLive(nuovoMovimento);

    chiudiModale('modal-spesa'); mostraMessaggio("SPESA REGISTRATA CON SUCCESSO");
};

window.salvaDistributore = async function () {
    let impString = document.getElementById('distributore-importo').value.trim().replace(',', '.'); let importo = parseFloat(impString); let dataSelezionata = document.getElementById('distributore-data').value;
    if (isNaN(importo) || importo <= 0) { mostraAvvisoModale("Inserisci un importo valido!"); return; } if (!dataSelezionata) { mostraAvvisoModale("Seleziona una data valida!"); return; }
    let d = new Date(); let hh = String(d.getHours()).padStart(2, '0'); let min = String(d.getMinutes()).padStart(2, '0');
    let nuovoMovimento = { data: dataSelezionata, ora: `${hh}:${min}`, tipo: "ENTRATA", importo: importo, descrizione: "Incasso Distributore" };

    // Salva nel PC e recupera l'ID
    nuovoMovimento.id = await salvaMovimentoCassaDB(nuovoMovimento);

    // 🔥 INVIA AL CRUSCOTTO FIREBASE
    if (typeof inviaMovimentoLive === "function") inviaMovimentoLive(nuovoMovimento);

    chiudiModale('modal-distributore'); mostraMessaggio("INCASSO DISTRIBUTORE REGISTRATO");
};

// ==========================================
// 🌟 LOGICA STORICO CALENDARIO (GIORNALE)
// ==========================================
const btnCalendario = document.getElementById('btn-calendario');

if (btnCalendario) {
    btnCalendario.addEventListener('click', async function () {
        await popolaStoricoCalendario();
        apriModale('modal-calendario');
    });
}

async function popolaStoricoCalendario() {
    let tutteVendite = await getAll('vendite');
    let tuttiMovimenti = await getAll('movimenti_cassa');

    let oggi = new Date();
    let anno = oggi.getFullYear();
    let mese = oggi.getMonth() + 1; // Mese corrente (1-12)
    let giornoOggi = oggi.getDate();

    // Trova quanti giorni ha il mese corrente in totale (es. 28, 30, 31)
    let giorniNelMese = new Date(anno, mese, 0).getDate();

    let strMese = String(mese).padStart(2, '0');
    let strAnno = String(anno);

    // Nomi dei mesi per il titolo
    const nomiMesi = ["Gennaio", "Febbraio", "Marzo", "Aprile", "Maggio", "Giugno", "Luglio", "Agosto", "Settembre", "Ottobre", "Novembre", "Dicembre"];
    document.getElementById('titolo-mese-calendario').textContent = `📅 GIORNALE - ${nomiMesi[oggi.getMonth()].toUpperCase()} ${anno}`;

    // 1. Inizializza l'oggetto con tutti i giorni dall'1 a OGGI (tutti a zero)
    let giornateMensili = {};
    for (let i = 1; i <= giornoOggi; i++) {
        let strGiorno = String(i).padStart(2, '0');
        let dataKey = `${strAnno}-${strMese}-${strGiorno}`;
        giornateMensili[dataKey] = { contanti: 0, pos: 0, distr: 0, uscite: 0, netto: 0 };
    }

    // 2. Somma le vendite del mese
    tutteVendite.forEach(v => {
        if (v.GIORNO && v.GIORNO.startsWith(`${strAnno}-${strMese}`)) {
            if (giornateMensili[v.GIORNO]) {
                giornateMensili[v.GIORNO].contanti += v.CONTANTI;
                giornateMensili[v.GIORNO].pos += v.POS;
            }
        }
    });

    // 3. Somma i movimenti (Spese e Distributore)
    tuttiMovimenti.forEach(m => {
        if (m.data && m.data.startsWith(`${strAnno}-${strMese}`)) {
            if (giornateMensili[m.data]) {
                if (m.tipo === 'ENTRATA') giornateMensili[m.data].distr += m.importo;
                if (m.tipo === 'USCITA') giornateMensili[m.data].uscite += m.importo;
            }
        }
    });

    // 4. Costruisci la tabella HTML e calcola i totali
    let htmlLista = "";
    let totContanti = 0, totPos = 0, totDistr = 0, totUscite = 0, totNettoMese = 0;
    let recordIncasso = 0;
    let dataRecord = "-";

    // Creiamo la lista dall'inizio del mese a oggi
    for (let i = 1; i <= giornoOggi; i++) {
        let strGiorno = String(i).padStart(2, '0');
        let dataKey = `${strAnno}-${strMese}-${strGiorno}`;
        let g = giornateMensili[dataKey];

        g.netto = g.contanti + g.pos + g.distr - g.uscite;

        // Aggiorna accumulatori
        totContanti += g.contanti;
        totPos += g.pos;
        totDistr += g.distr;
        totUscite += g.uscite;
        totNettoMese += g.netto;

        // Controlla record
        if (g.netto > recordIncasso) {
            recordIncasso = g.netto;
            dataRecord = `${strGiorno}/${strMese}/${strAnno}`;
        }

        // 🌟 FIX COLORE QUI: aggiunto "color: #b3d9ff;" alla colonna sinistra della data
        htmlLista += `
                            <div class="riga-prodotto" style="grid-template-columns: 1.5fr 1fr 1fr 1fr 1fr 1.2fr; cursor: default; border-bottom: 1px solid rgba(255,255,255,0.1);">
                                <div class="col-sinistra" style="color: #b3d9ff;">${strGiorno}/${strMese}/${strAnno}</div>
                                <div class="col-valuta" style="color: #ffffff;">€ ${g.contanti.toLocaleString('it-IT', { minimumFractionDigits: 2 })}</div>
                                <div class="col-valuta" style="color: #ffffff;">€ ${g.pos.toLocaleString('it-IT', { minimumFractionDigits: 2 })}</div>
                                <div class="col-valuta" style="color: #ffffff;">€ ${g.distr.toLocaleString('it-IT', { minimumFractionDigits: 2 })}</div>
                                <div class="col-valuta" style="color: #ff4d4d;">- € ${g.uscite.toLocaleString('it-IT', { minimumFractionDigits: 2 })}</div>
                                <div class="col-valuta" style="color: #00ffcc; font-weight: bold;">€ ${g.netto.toLocaleString('it-IT', { minimumFractionDigits: 2 })}</div>
                            </div>
                        `;
    }

    // HTML riga Totali Fissi in basso
    let htmlTotali = `
                        <div class="col-sinistra" style="color:#00ffcc;">TOTALI</div>
                        <div class="col-valuta" style="color:#ffcc00;">€ ${totContanti.toLocaleString('it-IT', { minimumFractionDigits: 2 })}</div>
                        <div class="col-valuta" style="color:#ffcc00;">€ ${totPos.toLocaleString('it-IT', { minimumFractionDigits: 2 })}</div>
                        <div class="col-valuta" style="color:#ffcc00;">€ ${totDistr.toLocaleString('it-IT', { minimumFractionDigits: 2 })}</div>
                        <div class="col-valuta" style="color:#ff4d4d;">- € ${totUscite.toLocaleString('it-IT', { minimumFractionDigits: 2 })}</div>
                        <div class="col-valuta" style="color:#00ffcc; font-size: 2.2vh;">€ ${totNettoMese.toLocaleString('it-IT', { minimumFractionDigits: 2 })}</div>
                    `;

    // Formule Medie e Proiezioni
    let mediaGiornaliera = giornoOggi > 0 ? (totNettoMese / giornoOggi) : 0;
    let proiezioneMensile = mediaGiornaliera * giorniNelMese;

    // Aggiorna l'interfaccia
    document.getElementById('calendario-lista').innerHTML = htmlLista;
    document.getElementById('calendario-totali-colonne').innerHTML = htmlTotali;

    document.getElementById('cal-tot-mese').textContent = '€ ' + totNettoMese.toLocaleString('it-IT', { minimumFractionDigits: 2 });
    document.getElementById('cal-media').textContent = '€ ' + mediaGiornaliera.toLocaleString('it-IT', { minimumFractionDigits: 2 });
    document.getElementById('cal-proiezione').textContent = '€ ' + proiezioneMensile.toLocaleString('it-IT', { minimumFractionDigits: 2 });
    document.getElementById('cal-best-val').textContent = '€ ' + recordIncasso.toLocaleString('it-IT', { minimumFractionDigits: 2 });
    document.getElementById('cal-best-date').textContent = dataRecord;
}

// ==========================================
// 🌟 LOGICA CONTABILITÀ E RICERCA AVANZATA
// ==========================================
const btnContabilita = document.getElementById('btn-contabilita');
const contMese = document.getElementById('cont-mese');
const contFiltroTipo = document.getElementById('cont-filtro-tipo');
const contCercaProd = document.getElementById('cont-cerca-prod');
const contCercaNome = document.getElementById('cont-cerca-nome');
const contCercaTel = document.getElementById('cont-cerca-tel');
const contListaRisultati = document.getElementById('cont-lista-risultati');

// Cache globale per la contabilità
let storicoCompletoContabilita = [];

if (btnContabilita) {
    btnContabilita.addEventListener('click', async function () {
        // Imposta il mese corrente di default
        let oggi = new Date();
        contMese.value = `${oggi.getFullYear()}-${String(oggi.getMonth() + 1).padStart(2, '0')}`;

        // Resetta gli altri campi
        contFiltroTipo.value = "TUTTI";
        contCercaProd.value = "";
        contCercaNome.value = "";
        contCercaTel.value = "";

        apriModale('modal-contabilita');
        await caricaDatiContabilita();
    });
}

// Funzione per scaricare TUTTO dal DB e creare un array unificato
async function caricaDatiContabilita() {
    let vendite = await getAll('vendite');
    let movimenti = await getAll('movimenti_cassa');

    storicoCompletoContabilita = [];

    // Aggiungiamo le vendite formattandole
    vendite.forEach(v => {
        storicoCompletoContabilita.push({
            sorgente: 'vendita',
            data: v.GIORNO,
            ora: v.ORA,
            cliente: v.CLIENTE,
            totale: v.CONTANTI + v.POS, // Totale pagato
            pagamento: v.POS > 0 ? "POS" : "CONTANTI",
            bonus: v.BONUS,
            puntiCaricati: v.PUNTI_CARICATI,
            articoli: v.ARTICOLI || [], // array del carrello
            raw: v // l'oggetto intero originale
        });
    });

    // Aggiungiamo i movimenti
    movimenti.forEach(m => {
        storicoCompletoContabilita.push({
            sorgente: 'movimento',
            data: m.data,
            ora: m.ora,
            tipoMov: m.tipo, // ENTRATA o USCITA
            descrizione: m.descrizione,
            totale: m.importo,
            raw: m
        });
    });

    // Ordiniamo tutto dal più recente al più vecchio (Data + Ora)
    storicoCompletoContabilita.sort((a, b) => {
        let dateTimeA = new Date(a.data + "T" + a.ora);
        let dateTimeB = new Date(b.data + "T" + b.ora);
        return dateTimeB - dateTimeA;
    });

    eseguiFiltriContabilita();
}

// Applica i filtri Live
function eseguiFiltriContabilita() {
    let filtroMese = contMese.value; // formato YYYY-MM
    let filtroTipo = contFiltroTipo.value;
    let txtProd = contCercaProd.value.toLowerCase().trim();
    let txtNome = contCercaNome.value.toLowerCase().trim();
    let txtTel = contCercaTel.value.toLowerCase().trim();

    let risultati = storicoCompletoContabilita.filter(item => {
        // 1. Filtro Mese
        if (filtroMese && !item.data.startsWith(filtroMese)) return false;

        // 2. Filtro Tipo (Dropdown)
        if (filtroTipo === "MULTIPLE" && (item.sorgente !== 'vendita' || item.articoli.length <= 1)) return false;
        if (filtroTipo === "BONUS" && (item.sorgente !== 'vendita' || item.bonus <= 0)) return false;
        if (filtroTipo === "USCITA" && (item.sorgente !== 'movimento' || item.tipoMov !== 'USCITA')) return false;
        if (filtroTipo === "ENTRATA" && (item.sorgente !== 'movimento' || item.tipoMov !== 'ENTRATA')) return false;

        // 3. Ricerca Nome Cliente
        if (txtNome !== "") {
            if (item.sorgente !== 'vendita') return false; // i movimenti non hanno nome
            if (!item.cliente.toLowerCase().includes(txtNome)) return false;
        }

        // 4. Ricerca Telefono/Scheda
        if (txtTel !== "") {
            if (item.sorgente !== 'vendita') return false;
            // Siccome nel db vendite salviamo solo il nome, se vogliamo cercare per telefono
            // dobbiamo averlo salvato o fare una query complessa. Nel nostro codice attuale
            // non salviamo il tel nella ricevuta. Cerca nella stringa cliente per sicurezza.
            if (!item.raw.CLIENTE.includes(txtTel)) return false;
        }

        // 5. Ricerca Prodotto
        if (txtProd !== "") {
            if (item.sorgente !== 'vendita') return false;
            let trovato = item.articoli.some(art => art.DESCRIZIONE.toLowerCase().includes(txtProd));
            if (!trovato) return false;
        }

        return true;
    });

    disegnaTabellaContabilita(risultati);
}

// Event Listeners per rendere la ricerca LIVE
contMese.addEventListener('change', eseguiFiltriContabilita);
contFiltroTipo.addEventListener('change', eseguiFiltriContabilita);
contCercaProd.addEventListener('input', eseguiFiltriContabilita);
contCercaNome.addEventListener('input', eseguiFiltriContabilita);
contCercaTel.addEventListener('input', eseguiFiltriContabilita);

function disegnaTabellaContabilita(arrayDati) {
    contListaRisultati.innerHTML = '';

    if (arrayDati.length === 0) {
        contListaRisultati.innerHTML = '<div style="text-align:center; padding: 30px; color: #8888bb; font-size: 2vh;">Nessun risultato trovato con questi filtri.</div>';
        return;
    }

    arrayDati.sort((a, b) => {
        let dataOraA = a.data + "T" + (a.ora || "00:00");
        let dataOraB = b.data + "T" + (b.ora || "00:00");
        if (dataOraA < dataOraB) return -1;
        if (dataOraA > dataOraB) return 1;
        return 0;
    });

    const gridStyle = '1.5fr 0.8fr 0.8fr 2fr 1fr 1fr 0.6fr 1fr 1fr 1fr 1fr 1fr 1fr 1fr';

    arrayDati.forEach((item) => {
        let dataParti = item.data.split('-');
        let giornoIT = `${dataParti[2]}/${dataParti[1]}/${dataParti[0]}`;

        if (item.sorgente === 'vendita') {
            let bonusUsato = item.bonus || 0;

            if (item.articoli && item.articoli.length > 0) {
                // Stampiamo UNA SOLA RIGA per l'intero scontrino
                let div = document.createElement('div');
                div.style.display = 'grid';
                div.style.gridTemplateColumns = gridStyle;
                div.style.padding = '10px 5px';
                div.style.borderBottom = '1px solid rgba(255,255,255,0.1)';
                div.style.fontSize = '1.5vh';
                div.style.alignItems = 'center';
                div.style.color = '#ffffff';
                div.style.transition = 'background-color 0.1s';
                div.style.cursor = 'pointer';

                div.onmouseover = function () { this.style.backgroundColor = 'rgba(255,255,255,0.2)'; }
                div.onmouseout = function () { this.style.backgroundColor = 'transparent'; }

                let strContanti = `€ ${item.raw.CONTANTI.toLocaleString('it-IT', { minimumFractionDigits: 2 })}`;
                let strPos = `€ ${item.raw.POS.toLocaleString('it-IT', { minimumFractionDigits: 2 })}`;
                let strBonus = bonusUsato > 0 ? `-€ ${bonusUsato.toLocaleString('it-IT', { minimumFractionDigits: 2 })}` : "€ 0,00";

                let strSIniz = item.raw.SALDO_PUNTI_INIZIALE !== undefined ? item.raw.SALDO_PUNTI_INIZIALE : "-";
                let strPCaric = `+${item.raw.PUNTI_CARICATI}`;
                let strPScaric = `-${item.raw.PUNTI_SCARICATI}`;
                let strSFin = item.raw.SALDO_PUNTI_FINALE !== undefined ? item.raw.SALDO_PUNTI_FINALE : "-";

                let strCliente = item.cliente;

                // Se è un solo articolo mostra il nome, altrimenti mostra VENDITA MULTIPLA per far quadrare i totali
                let desc = "";
                let cat = "";
                let importoMerce = 0;
                let quantitaTotale = 0;

                if (item.articoli.length === 1) {
                    desc = item.articoli[0].DESCRIZIONE;
                    cat = item.articoli[0].CATEGORIA || '-';
                    importoMerce = item.articoli[0].IMPORTO;
                    quantitaTotale = item.articoli[0].QUANTITA;
                } else {
                    desc = `VENDITA MULTIPLA (${item.articoli.length} ART.)`;
                    cat = "MULTIPLA";
                    item.articoli.forEach(a => {
                        importoMerce += a.IMPORTO;
                        quantitaTotale += a.QUANTITA;
                    });
                }

                desc += ` <span style="font-size: 1.2vh; background: #4d88ff; padding: 2px 4px; border-radius: 3px; color: white; margin-left: 5px;" title="Vedi Dettaglio">👁️</span>`;

                div.innerHTML = `
                            <div style="text-align: left !important; color: #b3d9ff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${strCliente}">${strCliente}</div>
                            <div style="text-align: center !important;">${giornoIT}</div>
                            <div style="text-align: center !important;">${item.ora}</div>
                            <div style="text-align: left !important; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="Clicca per i dettagli">${desc}</div>
                            <div style="text-align: center !important;">${cat}</div>
                            <div style="text-align: center !important; color: #00ffcc;">€ ${importoMerce.toLocaleString('it-IT', { minimumFractionDigits: 2 })}</div>
                            <div style="text-align: center !important;">${quantitaTotale}</div>
                            
                            <div style="text-align: center !important; color: #ffcc00;">${strContanti}</div>
                            <div style="text-align: center !important; color: #ffcc00;">${strPos}</div>
                            
                            <div style="text-align: center !important;">${strSIniz}</div>
                            <div style="text-align: center !important; color: #00cc66;">${strPCaric}</div>
                            <div style="text-align: center !important; color: #ff4d4d;">${strPScaric}</div>
                            <div style="text-align: center !important; color: #ff6666;">${strBonus}</div>
                            <div style="text-align: center !important; font-weight: bold;">${strSFin}</div>
                        `;

                div.addEventListener('click', () => apriDettaglioScontrino(item.raw));
                contListaRisultati.appendChild(div);
            }
        } else {
            let div = document.createElement('div');
            div.style.display = 'grid';
            div.style.gridTemplateColumns = gridStyle;
            div.style.padding = '10px 5px';
            div.style.borderBottom = '1px solid rgba(255,255,255,0.1)';
            div.style.fontSize = '1.5vh';
            div.style.alignItems = 'center';
            div.style.color = '#ffffff';

            let coloreTipo = item.tipoMov === 'ENTRATA' ? '#00cc66' : '#ff4d4d';
            let segno = item.tipoMov === 'ENTRATA' ? '+' : '-';

            div.innerHTML = `
                        <div style="text-align: center !important; color: #666;">-</div>
                        <div style="text-align: center !important;">${giornoIT}</div>
                        <div style="text-align: center !important;">${item.ora}</div>
                        <div style="text-align: left !important; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${item.descrizione}</div>
                        <div style="text-align: center !important; color: ${coloreTipo}; font-weight: bold;">${item.tipoMov}</div>
                        <div style="text-align: center !important; color: ${coloreTipo};">€ ${item.totale.toLocaleString('it-IT', { minimumFractionDigits: 2 })}</div>
                        <div style="text-align: center !important;">-</div>
                        
                        <div style="text-align: center !important; color: ${coloreTipo};">${item.tipoMov === 'ENTRATA' ? segno : ''}€ ${item.totale.toLocaleString('it-IT', { minimumFractionDigits: 2 })}</div>
                        <div style="text-align: center !important;">-</div>
                        
                        <div style="text-align: center !important;">-</div>
                        <div style="text-align: center !important;">-</div>
                        <div style="text-align: center !important;">-</div>
                        <div style="text-align: center !important;">-</div>
                        <div style="text-align: center !important;">-</div>
                    `;
            contListaRisultati.appendChild(div);
        }
    });
}

// 🌟 APERTURA DETTAGLIO SCONTRINO (Lettura array ARTICOLI)
// Funzione ponte per aprire il dettaglio direttamente dal Registro Giornaliero
window.visualizzaScontrinoDaRegistro = async function (idScontrino) {
    let scontrino = await getRecordById('vendite', idScontrino);
    if (scontrino) {
        apriDettaglioScontrino(scontrino);
    }
};
window.apriDettaglioScontrino = function (venditaRaw) {
    let dataIT = venditaRaw.GIORNO.split('-').reverse().join('/');
    document.getElementById('det-dataora').textContent = `${dataIT} - Ore ${venditaRaw.ORA}`;
    document.getElementById('det-cliente').textContent = venditaRaw.CLIENTE !== "Nessuno" ? "Cliente: " + venditaRaw.CLIENTE : "Scontrino Libero";

    let listaHTML = "";
    let totaleMerce = 0;

    if (venditaRaw.ARTICOLI && venditaRaw.ARTICOLI.length > 0) {
        venditaRaw.ARTICOLI.forEach(art => {
            listaHTML += `
                            <div style="display: flex; justify-content: space-between; margin-bottom: 5px;">
                                <span>${art.QUANTITA}x ${art.DESCRIZIONE}</span>
                                <span>€ ${art.IMPORTO.toLocaleString('it-IT', { minimumFractionDigits: 2 })}</span>
                            </div>
                        `;
            totaleMerce += art.IMPORTO;
        });
    } else {
        listaHTML = "<i>Nessun dettaglio articoli salvato</i>";
    }

    document.getElementById('det-lista-articoli').innerHTML = listaHTML;
    document.getElementById('det-totale-merce').textContent = "€ " + totaleMerce.toLocaleString('it-IT', { minimumFractionDigits: 2 });
    document.getElementById('det-bonus').textContent = "- € " + (venditaRaw.BONUS || 0).toLocaleString('it-IT', { minimumFractionDigits: 2 });

    let pagato = venditaRaw.CONTANTI + venditaRaw.POS;
    document.getElementById('det-pagato').textContent = "€ " + pagato.toLocaleString('it-IT', { minimumFractionDigits: 2 });
    document.getElementById('det-tipo-pagamento').textContent = venditaRaw.POS > 0 ? "Pagamento Elettronico (POS)" : "Contanti";

    if (venditaRaw.CLIENTE !== "Nessuno") {
        document.getElementById('det-punti-guadagnati').textContent = `Punti Guadagnati: +${venditaRaw.PUNTI_CARICATI}`;
        document.getElementById('det-saldo-punti').textContent = `Saldo Finale: ${venditaRaw.SALDO_PUNTI_FINALE} PTS`;
    } else {
        document.getElementById('det-punti-guadagnati').textContent = "";
        document.getElementById('det-saldo-punti').textContent = "";
    }

    apriModale('modal-dettaglio-scontrino');
}

// ==========================================
// 🌟 LOGICA STATISTICHE (BUSINESS INTELLIGENCE)
// ==========================================
const btnStatistiche = document.getElementById('btn-statistiche');
let statTuttiClienti = [];
let statTutteVendite = [];

if (btnStatistiche) {
    btnStatistiche.addEventListener('click', async function () {
        apriModale('modal-statistiche');
        await caricaDatiStatistiche();
    });
}

async function caricaDatiStatistiche() {
    statTuttiClienti = await getAll('clienti');
    statTutteVendite = await getAll('vendite');

    calcolaSemafori();
    calcolaTopProdotti();

    document.getElementById('stat-cerca-cliente').value = '';
    document.getElementById('stat-lista-clienti-ricerca').style.display = 'none';
    document.getElementById('stat-dettaglio-cliente').style.display = 'none';
}

function calcolaSemafori() {
    let oggi = new Date();
    let countVerdi = 0, countGialli = 0, countRossi = 0;

    statTuttiClienti.forEach(c => {
        if (c.dataUltimaOperazione) {
            let dOp = new Date(c.dataUltimaOperazione);
            let diffTime = Math.abs(oggi - dOp);
            let diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
            c.giorniAssenza = diffDays;

            if (diffDays <= 30) countVerdi++;
            else if (diffDays <= 60) countGialli++;
            else countRossi++;
        } else {
            c.giorniAssenza = 999;
            countRossi++;
        }
    });

    document.getElementById('stat-verdi').textContent = countVerdi;
    document.getElementById('stat-gialli').textContent = countGialli;
    document.getElementById('stat-rossi').textContent = countRossi;
}

// Apre il dettaglio del semaforo cliccato
window.mostraListaSemaforo = function (tipo) {
    let filtrati = [];
    let colore = "";
    let titolo = "";

    if (tipo === 'VERDE') { filtrati = statTuttiClienti.filter(c => c.giorniAssenza <= 30); colore = "#00cc66"; titolo = "🟢 CLIENTI ATTIVI"; }
    else if (tipo === 'GIALLO') { filtrati = statTuttiClienti.filter(c => c.giorniAssenza > 30 && c.giorniAssenza <= 60); colore = "#ffcc00"; titolo = "🟡 DA RICONTATTARE"; }
    else if (tipo === 'ROSSO') { filtrati = statTuttiClienti.filter(c => c.giorniAssenza > 60); colore = "#ff4d4d"; titolo = "🔴 CLIENTI DORMIENTI"; }

    // Mette in alto chi manca da più tempo
    filtrati.sort((a, b) => b.giorniAssenza - a.giorniAssenza);

    let html = "";
    filtrati.forEach(c => {
        let btnWa = `<a href="whatsapp://send?phone=39${c.telefono}" style="text-decoration:none; color:white; background:#25D366; padding:4px 8px; border-radius:4px; font-size:1.6vh; font-weight:bold;">💬 Contatta</a>`;
        html += `<div style="display:flex; justify-content:space-between; padding: 12px; border-bottom: 1px solid rgba(255,255,255,0.1);">
                                    <div><b style="color:white; font-size:2vh;">${c.nome}</b><br><span style="font-size:1.6vh; color:#b3d9ff;">Assente da ${c.giorniAssenza} gg</span></div>
                                    <div style="display:flex; align-items:center;">${btnWa}</div>
                                 </div>`;
    });

    if (html === "") html = "<p style='text-align:center;'>Nessun cliente in questa categoria.</p>";

    document.getElementById('titolo-lista-semaforo').textContent = titolo;
    document.getElementById('titolo-lista-semaforo').style.color = colore;
    document.getElementById('lista-semaforo-content').innerHTML = html;

    apriModale('modal-lista-semaforo');
};

// Calcola e ordina la classifica dei prodotti (Totalmente separata)
function calcolaTopProdotti() {
    let mappaProdotti = {};

    statTutteVendite.forEach(v => {
        if (v.ARTICOLI && v.ARTICOLI.length > 0) {
            v.ARTICOLI.forEach(art => {
                let nome = art.DESCRIZIONE;
                if (nome.includes("MOVIMENTO MANUALE PUNTI")) return;

                if (!mappaProdotti[nome]) {
                    mappaProdotti[nome] = { nome: nome, quantita: 0, incasso: 0 };
                }
                mappaProdotti[nome].quantita += art.QUANTITA;
                mappaProdotti[nome].incasso += art.IMPORTO;
            });
        }
    });

    let arrayProdotti = Object.values(mappaProdotti);
    arrayProdotti.sort((a, b) => b.incasso - a.incasso); // Ordine per Incasso Maggiore

    let html = "";
    arrayProdotti.forEach(p => {
        html += `
                    <div style="display: grid; align-items: center; grid-template-columns: 2fr 1fr 1.5fr; cursor: default; border-bottom: 1px solid rgba(255,255,255,0.1); padding: 8px 5px; transition: background 0.2s;" onmouseover="this.style.backgroundColor='rgba(255,255,255,0.1)'" onmouseout="this.style.backgroundColor='transparent'">
                        <div class="col-sinistra" style="color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${p.nome}">${p.nome}</div>
                        <div class="col-centro" style="color: #b3d9ff;">${p.quantita} pz</div>
                        <div class="col-valuta" style="color: #00ffcc; font-weight: bold;">€ ${p.incasso.toLocaleString('it-IT', { minimumFractionDigits: 2 })}</div>
                    </div>
                `;
    });

    if (html === "") html = "<div style='text-align:center; padding: 20px; color:#8888bb;'>Nessuna vendita registrata.</div>";
    document.getElementById('stat-lista-prodotti').innerHTML = html;
}

// Autocompletamento Ricerca Singolo Cliente
const inCercaStatCliente = document.getElementById('stat-cerca-cliente');
const boxRisultatiStat = document.getElementById('stat-lista-clienti-ricerca');

inCercaStatCliente.addEventListener('input', function () {
    let txt = this.value.toLowerCase().trim();
    if (txt.length < 2) { boxRisultatiStat.style.display = 'none'; return; }

    let filtrati = statTuttiClienti.filter(c => c.nome.toLowerCase().includes(txt) || c.telefono.includes(txt));

    if (filtrati.length > 0) {
        let html = "";
        filtrati.forEach(c => {
            html += `<div style="padding: 10px; border-bottom: 1px solid #eee; cursor: pointer; color: #000; font-size:1.8vh;" 
                                  onclick="selezionaClienteStatistica('${c.scheda}')"
                                  onmouseover="this.style.backgroundColor='#d8d8ff'"
                                  onmouseout="this.style.backgroundColor='transparent'">
                                <b>${c.nome}</b> (${c.telefono})
                             </div>`;
        });
        boxRisultatiStat.innerHTML = html;
        boxRisultatiStat.style.display = 'block';
    } else {
        boxRisultatiStat.style.display = 'none';
    }
});

// Mostra Resoconto Dettagliato del cliente (con storico completo 14 colonne)
window.selezionaClienteStatistica = function (schedaCliente) {
    boxRisultatiStat.style.display = 'none';
    let c = statTuttiClienti.find(x => x.scheda === schedaCliente);
    if (!c) return;

    inCercaStatCliente.value = c.nome;

    let totaleSpeso = 0;
    let totaleVisite = 0;
    let totaleBonusRiscattati = 0;
    let dataUltimoBonus = "-";
    let importoUltimoBonus = 0;
    let mappaPreferiti = {};
    let righeHtml = "";

    // 1. Filtra solo le vendite di questo cliente e ordinale dalla più recente alla più vecchia
    let venditeCliente = statTutteVendite.filter(v => v.CLIENTE === c.nome);
    venditeCliente.sort((a, b) => new Date(b.GIORNO + "T" + b.ORA) - new Date(a.GIORNO + "T" + a.ORA));

    const nomiMesi = ["Gen", "Feb", "Mar", "Apr", "Mag", "Giu", "Lug", "Ago", "Set", "Ott", "Nov", "Dic"];

    venditeCliente.forEach(v => {
        totaleVisite++;
        totaleSpeso += (v.CONTANTI + v.POS);

        let bonusUsato = v.BONUS || 0;
        totaleBonusRiscattati += bonusUsato;

        // Calcolo data e importo ultimo bonus (essendo ordinate dalla più recente, il primo che troviamo > 0 è l'ultimo)
        if (bonusUsato > 0 && dataUltimoBonus === "-") {
            let partiData = v.GIORNO.split('-');
            dataUltimoBonus = `${partiData[2]}/${partiData[1]}/${partiData[0]}`;
            importoUltimoBonus = bonusUsato; // <-- Salviamo l'importo dell'ultimo
        }

        // Formattazione Date per la tabella
        let dataParti = v.GIORNO.split('-');
        let meseTesto = nomiMesi[parseInt(dataParti[1]) - 1];
        let giornoIT = `${dataParti[2]}/${dataParti[1]}/${dataParti[0]}`;

        // Generazione righe tabella per ogni ARTICOLO nello scontrino
        if (v.ARTICOLI && v.ARTICOLI.length > 0) {
            v.ARTICOLI.forEach((art, index) => {
                // Statistica prodotto preferito
                if (!art.DESCRIZIONE.includes("MOVIMENTO MANUALE PUNTI")) {
                    if (!mappaPreferiti[art.DESCRIZIONE]) mappaPreferiti[art.DESCRIZIONE] = 0;
                    mappaPreferiti[art.DESCRIZIONE] += art.QUANTITA;
                }

                // Per evitare di ripetere i dati di pagamento e punti su ogni riga dello stesso scontrino,
                // li stampiamo in modo visibile sulla prima riga, e li sfumiamo sulle successive (opzionale, qui li mettiamo su tutte per chiarezza DB)

                let strContanti = index === 0 ? `€ ${v.CONTANTI.toLocaleString('it-IT', { minimumFractionDigits: 2 })}` : "-";
                let strPos = index === 0 ? `€ ${v.POS.toLocaleString('it-IT', { minimumFractionDigits: 2 })}` : "-";
                let strBonus = index === 0 && bonusUsato > 0 ? `-€ ${bonusUsato.toLocaleString('it-IT', { minimumFractionDigits: 2 })}` : (index === 0 ? "€ 0,00" : "-");

                righeHtml += `
                            <div style="display: grid; align-items: center; grid-template-columns: 0.6fr 0.8fr 0.8fr 2.5fr 1fr 1fr 0.6fr 1fr 1fr 1fr 1fr 1fr 1fr 1fr; font-size: 1.5vh; padding: 10px 5px; border-bottom: 1px solid rgba(255,255,255,0.1); cursor: default; color: #fff; transition: background 0.2s;" onmouseover="this.style.backgroundColor='rgba(255,255,255,0.1)'" onmouseout="this.style.backgroundColor='transparent'">
                                <div class="col-centro" style="color: #b3d9ff;">${meseTesto}</div>
                                <div class="col-centro">${giornoIT}</div>
                                <div class="col-centro">${v.ORA}</div>
                                <div class="col-sinistra" style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${art.DESCRIZIONE}">${art.DESCRIZIONE}</div>
                                <div class="col-centro">${art.CATEGORIA || '-'}</div>
                                <div class="col-valuta" style="color: #00ffcc;">€ ${art.IMPORTO.toLocaleString('it-IT', { minimumFractionDigits: 2 })}</div>
                                <div class="col-centro">${art.QUANTITA}</div>
                                
                                <div class="col-valuta" style="color: #ffcc00;">${strContanti}</div>
                                <div class="col-valuta" style="color: #ffcc00;">${strPos}</div>
                                <div class="col-valuta" style="color: #ff6666;">${strBonus}</div>
                                
                                <div class="col-centro">${index === 0 ? v.SALDO_PUNTI_INIZIALE : "-"}</div>
                                <div class="col-centro" style="color: #00cc66;">${index === 0 ? '+' + v.PUNTI_CARICATI : "-"}</div>
                                <div class="col-centro" style="color: #ff4d4d;">${index === 0 ? '-' + v.PUNTI_SCARICATI : "-"}</div>
                                <div class="col-centro" style="font-weight: bold; color: #fff;">${index === 0 ? v.SALDO_PUNTI_FINALE : "-"}</div>
                            </div>
                        `;
            });
        }
    });

    if (righeHtml === "") righeHtml = "<div style='padding: 20px; text-align: center; color: #8888bb;'>Nessun acquisto registrato per questo cliente.</div>";

    let scontrinoMedio = totaleVisite > 0 ? (totaleSpeso / totaleVisite) : 0;

    let preferito = "-";
    let maxQty = 0;
    for (let key in mappaPreferiti) {
        if (mappaPreferiti[key] > maxQty) {
            maxQty = mappaPreferiti[key];
            preferito = key;
        }
    }

    // Popola i dati a schermo
    document.getElementById('stat-det-nome').textContent = c.nome;
    document.getElementById('stat-det-speso').textContent = "€ " + totaleSpeso.toLocaleString('it-IT', { minimumFractionDigits: 2 });
    document.getElementById('stat-det-visite').textContent = totaleVisite;
    document.getElementById('stat-det-scontrino-medio').textContent = "€ " + scontrinoMedio.toLocaleString('it-IT', { minimumFractionDigits: 2 });
    document.getElementById('stat-det-preferito').textContent = maxQty > 0 ? `${preferito} (${maxQty} pz)` : "Nessun dato";

    // STAMPA AGGIORNATA DEI BONUS
    document.getElementById('stat-det-tot-bonus').textContent = "€ " + totaleBonusRiscattati.toLocaleString('it-IT', { minimumFractionDigits: 2 });

    if (dataUltimoBonus !== "-") {
        document.getElementById('stat-det-ultimo-bonus').textContent = `€ ${importoUltimoBonus.toLocaleString('it-IT', { minimumFractionDigits: 2 })} (${dataUltimoBonus})`;
    } else {
        document.getElementById('stat-det-ultimo-bonus').textContent = "Nessuno";
    }

    document.getElementById('stat-tabella-acquisti').innerHTML = righeHtml;

    document.getElementById('stat-dettaglio-cliente').style.display = 'flex';
};

// ============================================================
// 🌐 LOGICA DI SISTEMA E CAMBIO GIORNO (WIFI, OROLOGIO, DATA)
// ============================================================

const sysWifi = document.getElementById('sys-wifi');
const sysOrologio = document.getElementById('sys-orologio');
const sysData = document.getElementById('sys-data');

// Memoria per il cambio giorno automatico
let dataCorrenteSistema = getOggiString();

// 0. Gestione Spia Wi-Fi (Online/Offline) e Stato Menu
window.aggiornaStatoRete = function () {
    // Aggiorna la spia in alto a sinistra nella Cassa
    if (sysWifi) {
        if (navigator.onLine) {
            sysWifi.innerHTML = '🟢 ONLINE';
            sysWifi.style.color = '#00cc66';
        } else {
            sysWifi.innerHTML = '🔴 OFFLINE';
            sysWifi.style.color = '#ff4d4d';
        }
    }

    // Aggiorna la scritta in fondo al Menu Principale
    let menuStatus = document.getElementById('menu-status-web');
    if (menuStatus) {
        if (navigator.onLine) {
            menuStatus.innerHTML = '<span style="color: #00cc66; font-weight: bold;">Collegato 🟢</span>';
        } else {
            menuStatus.innerHTML = '<span style="color: #ff4d4d; font-weight: bold;">Scollegato 🔴</span>';
        }
    }
};

// Ascolta i cambiamenti di connessione in tempo reale
window.addEventListener('online', aggiornaStatoRete);
window.addEventListener('offline', aggiornaStatoRete);
aggiornaStatoRete(); // Controlla subito all'avvio

// 1. Gestione Orologio, Data e AZZERAMENTO MEZZANOTTE
function aggiornaOrologio() {
    const adesso = new Date();

    // Orologio
    const hh = String(adesso.getHours()).padStart(2, '0');
    const mm = String(adesso.getMinutes()).padStart(2, '0');
    const ss = String(adesso.getSeconds()).padStart(2, '0');
    if (sysOrologio) sysOrologio.textContent = `${hh}:${mm}:${ss}`;

    // Data
    const gg = String(adesso.getDate()).padStart(2, '0');
    const mese = String(adesso.getMonth() + 1).padStart(2, '0');
    const anno = adesso.getFullYear();
    if (sysData) sysData.textContent = `${gg}/${mese}/${anno}`;

    // 🌟 SENTINELLA DI MEZZANOTTE: Azzera tutto al cambio giorno
    let nuovaData = `${anno}-${mese}-${gg}`;
    if (nuovaData !== dataCorrenteSistema) {
        dataCorrenteSistema = nuovaData; // Aggiorna la memoria al nuovo giorno

        // 1. Svuota la cassa e annulla scontrini in sospeso
        if (btnCestino) btnCestino.click();

        // 2. Chiude forzatamente qualsiasi finestra/registro aperto di ieri
        document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');

        // 🔥 3. AZZERAMENTO FIREBASE (Svuota l'intero cruscotto online per il nuovo giorno)
        if (navigator.onLine) {
            fetch(`${FIREBASE_URL}/vendite_live.json`, { method: 'DELETE' }).catch(e => console.log(e));
        }

        // 4. Mostra l'avviso con la modale custom
        mostraAvvisoModale("🌙 <b>CAMBIO GIORNO EFFETTUATO</b><br><br>È scattata la mezzanotte.<br>Il registro di cassa e il cruscotto online sono stati azzerati e preparati per oggi.");

        // 5. Riporta l'operatore al menu principale per iniziare la giornata
        apriModale('modal-menu-principale');
    }
}

// Aggiorna l'orologio ogni secondo
setInterval(aggiornaOrologio, 1000);
aggiornaOrologio(); // Avvio immediato

// ====================================================
// 🏠 LOGICA MENU PRINCIPALE E NAVIGAZIONE INTELLIGENTE
// ====================================================

// Variabile di memoria per capire da dove arriviamo
let apertoDaMenu = false;

// Intercetta i click sui bottoni fisici in alto della Cassa
// Se l'utente clicca un bottone dalla Cassa, la provenienza "Menu" si cancella
document.querySelectorAll('.sezione-tasti .tasto-fisico').forEach(btn => {
    btn.addEventListener('click', () => {
        apertoDaMenu = false;
    });
});

// Nuova funzione intelligente per la chiusura dei moduli
window.chiudiModulo = function (idModal) {
    chiudiModale(idModal); // Chiude visivamente la finestra

    // Se eravamo partiti dal menu, lo riapriamo automaticamente
    if (apertoDaMenu) {
        apriModale('modal-menu-principale');
    }
};

// Funzione chiamata dai pulsanti del Menu di Avvio
window.avviaFunzione = function (tipo) {
    chiudiModale('modal-menu-principale'); // Nasconde il menu

    switch (tipo) {
        case 'CASSA':
            apertoDaMenu = false; // Azzera la memoria
            mostraMessaggio("MODALITÀ CASSA ATTIVA");
            break;
        case 'CLIENTI':
            document.getElementById('btn-clienti').click();
            apertoDaMenu = true; // Registra la memoria DOPO il click
            break;
        case 'CALENDARIO':
            document.getElementById('btn-calendario').click();
            apertoDaMenu = true;
            break;
        case 'CONTABILITA':
            document.getElementById('btn-contabilita').click();
            apertoDaMenu = true;
            break;
        case 'PUNTI':
            document.getElementById('btn-preferiti').click();
            apertoDaMenu = true;
            break;
        case 'CHIUSURA':
            document.getElementById('btn-registro').click();
            apertoDaMenu = true;
            break;
        case 'MAGAZZINO':
            document.getElementById('btn-magazzino').click();
            apertoDaMenu = true;
            break;
        case 'SETUP':
            caricaImpostazioniAvanzate();
            apriModale('modal-impostazioni-menu'); // <-- PUNTA AL NUOVO MENU MODULARE!
            apertoDaMenu = true;
            break;
        case 'STATISTICHE':
            calcolaStatistiche(); // Calcola i dati prima di aprire
            apriModale('modal-dashboard-vendite');
            apertoDaMenu = true;
            break;
    }
};

// ==========================================
// 📦 LOGICA GESTIONE MAGAZZINO
// ==========================================
const btnMagazzino = document.getElementById('btn-magazzino');
const inMagCodice = document.getElementById('mag-codice');
const inMagDescrizione = document.getElementById('mag-descrizione');
const inMagCategoria = document.getElementById('mag-categoria');
const inMagGiacenza = document.getElementById('mag-giacenza');
const inMagPrezzoAcq = document.getElementById('mag-prezzo-acq');
const inMagPrezzoVen = document.getElementById('mag-prezzo-ven');
const btnMagElimina = document.getElementById('mag-btn-elimina');
const searchMag = document.getElementById('mag-search');
const magListaHTML = document.getElementById('mag-list');

let listaMagazzinoCompleta = [];

if (btnMagazzino) {
    btnMagazzino.addEventListener('click', async function () {
        apriModale('modal-magazzino');
        await magCaricaLista();
        magNuovoProdotto();
        searchMag.value = '';
        searchMag.focus();
    });
}

async function magCaricaLista() {
    listaMagazzinoCompleta = await getAll('magazzino');
    listaMagazzinoCompleta.sort((a, b) => a.descrizione.localeCompare(b.descrizione));
    magDisegnaLista(listaMagazzinoCompleta);
    magCalcolaStatistiche();
}

function magCalcolaStatistiche() {
    let totaleArticoli = listaMagazzinoCompleta.length;
    let valoreMagazzino = 0;

    listaMagazzinoCompleta.forEach(p => {
        // Calcola il valore in base al prezzo di acquisto (se presente), altrimenti usa il prezzo di vendita
        let prezzoRiferimento = p.prezzoAcquisto > 0 ? p.prezzoAcquisto : p.prezzo;
        let qta = parseInt(p.giacenza) || 0;
        valoreMagazzino += (prezzoRiferimento * qta);
    });

    document.getElementById('mag-stat-articoli').textContent = totaleArticoli;
    document.getElementById('mag-stat-valore').textContent = "€ " + valoreMagazzino.toLocaleString('it-IT', { minimumFractionDigits: 2 });
}

function magDisegnaLista(arrayProdotti) {
    magListaHTML.innerHTML = '';
    arrayProdotti.forEach(p => {
        let giacenzaColore = p.giacenza <= 5 ? '#ff4d4d' : '#b3d9ff'; // Rosso se in esaurimento

        let div = document.createElement('div');
        div.className = 'crm-list-item';
        div.innerHTML = `
                            <div class="crm-list-nome">${p.descrizione}</div>
                            <div class="crm-list-dati">
                                <span style="color: #ffcc00;">[${p.codice}]</span>
                                <span style="color: ${giacenzaColore}; font-weight: bold;">📦 ${p.giacenza} pz</span>
                                <span style="color: #00ffcc;">€ ${p.prezzo.toLocaleString('it-IT', { minimumFractionDigits: 2 })}</span>
                            </div>
                        `;
        div.addEventListener('click', () => {
            document.querySelectorAll('#mag-list .crm-list-item').forEach(el => el.classList.remove('attivo'));
            div.classList.add('attivo');
            magCaricaScheda(p);
        });
        magListaHTML.appendChild(div);
    });
}

searchMag.addEventListener('input', function () {
    let t = this.value.toLowerCase().trim();
    if (t === '') { magDisegnaLista(listaMagazzinoCompleta); return; }
    let filtrati = listaMagazzinoCompleta.filter(p =>
        p.descrizione.toLowerCase().includes(t) ||
        p.codice.toLowerCase().includes(t) ||
        (p.categoria && p.categoria.toLowerCase().includes(t))
    );
    magDisegnaLista(filtrati);
});

function magCaricaScheda(p) {
    document.getElementById('mag-titolo-scheda').textContent = "MODIFICA ARTICOLO";
    inMagCodice.value = p.codice;
    inMagCodice.disabled = true;
    document.getElementById('btn-genera-mag-codice').style.display = 'none'; // Nascondi bottone genera

    inMagDescrizione.value = p.descrizione;
    inMagCategoria.value = p.categoria || "";
    inMagGiacenza.value = p.giacenza;
    inMagPrezzoVen.value = p.prezzo.toLocaleString('it-IT', { minimumFractionDigits: 2 });
    inMagPrezzoAcq.value = (p.prezzoAcquisto || 0).toLocaleString('it-IT', { minimumFractionDigits: 2 });

    btnMagElimina.style.display = 'block';
}

window.magNuovoProdotto = function () {
    document.getElementById('mag-titolo-scheda').textContent = "NUOVO ARTICOLO";
    inMagCodice.value = '';
    inMagCodice.disabled = false;
    document.getElementById('btn-genera-mag-codice').style.display = 'block'; // Mostra bottone genera

    inMagDescrizione.value = '';
    inMagCategoria.value = '';
    inMagGiacenza.value = '0';
    inMagPrezzoAcq.value = '';
    inMagPrezzoVen.value = '';
    btnMagElimina.style.display = 'none';
    document.querySelectorAll('#mag-list .crm-list-item').forEach(el => el.classList.remove('attivo'));
    inMagCodice.focus();
};

// 🌟 GENERATORE CODICI A BARRE INTERNI (Iniziano con 210)
window.generaCodiceMagazzinoUnivoco = async function () {
    let unico = false;
    let nuovoCodice = "";
    let btnGen = document.getElementById('btn-genera-mag-codice');
    btnGen.innerHTML = "⏳...";

    while (!unico) {
        // Crea un numero di 13 cifre che inizia con '210' (standard codici interni)
        let cifreRandom = Math.floor(Math.random() * 10000000000).toString().padStart(10, '0');
        nuovoCodice = "210" + cifreRandom;

        // Controlla nel DB se esiste già
        let magazzinoCompleto = await getAll('magazzino');
        let esiste = magazzinoCompleto.find(p => p.codice === nuovoCodice);
        if (!esiste) {
            unico = true;
        }
    }

    document.getElementById('mag-codice').value = nuovoCodice;
    btnGen.innerHTML = "🎲 GENERA";
    document.getElementById('mag-categoria').focus(); // Passa al campo successivo
};

// Filtri per far scrivere solo numeri nei campi importo/giacenza
inMagGiacenza.addEventListener('input', function () { this.value = this.value.replace(/[^0-9-]/g, ''); });
inMagPrezzoVen.addEventListener('input', function () { this.value = this.value.replace(/[^0-9.,]/g, ''); });
inMagPrezzoAcq.addEventListener('input', function () { this.value = this.value.replace(/[^0-9.,]/g, ''); });

window.magSalvaProdotto = async function () {
    let codice = inMagCodice.value.trim();
    let descrizione = inMagDescrizione.value.trim().toUpperCase();
    let categoria = inMagCategoria.value.trim().toUpperCase() || "VARIE";
    let giacenza = parseInt(inMagGiacenza.value) || 0;
    let prezzoAcq = parseFloat(inMagPrezzoAcq.value.replace(',', '.')) || 0;
    let prezzoVen = parseFloat(inMagPrezzoVen.value.replace(',', '.')) || 0;

    if (codice === '' || descrizione === '' || prezzoVen <= 0) {
        mostraAvvisoModale("Compila i campi obbligatori:<br>- Codice<br>- Descrizione<br>- Prezzo di Vendita (maggiore di 0)");
        return;
    }

    // IndexedDB Gestione
    let tx = db.transaction('magazzino', 'readwrite');
    let store = tx.objectStore('magazzino');

    let nuovoProdotto = {
        codice: codice,
        descrizione: descrizione,
        categoria: categoria,
        giacenza: giacenza,
        prezzoAcquisto: prezzoAcq,
        prezzo: prezzoVen,
        tipo: "PZ"
    };

    store.put(nuovoProdotto); // Upsert automatico

    tx.oncomplete = async () => {

        // 🔥 CLOUD-SYNC: Spara il prodotto al cloud appena salvato in locale
        if (typeof salvaProdottoCloud === "function") {
            salvaProdottoCloud(nuovoProdotto);
        }

        document.getElementById('mag-titolo-scheda').textContent = "✅ SALVATO!";
        document.getElementById('mag-titolo-scheda').style.color = "#00ff00";
        setTimeout(() => {
            document.getElementById('mag-titolo-scheda').textContent = "MODIFICA ARTICOLO";
            document.getElementById('mag-titolo-scheda').style.color = "white";
        }, 1500);

        await magCaricaLista();
        inMagCodice.disabled = true;
        btnMagElimina.style.display = 'block';
    };
};

// ==========================================
// 🔥 CONNESSIONE FIREBASE REALTIME DATABASE
// ==========================================
const FIREBASE_URL = "https://fidelity-gestionale-default-rtdb.europe-west1.firebasedatabase.app";

// 1. Aggiorna il nodo principale del cliente (Solo Punti e Data)
async function aggiornaFidelityFirebase(numeroScheda, nuoviPunti, dataOperazione) {
    if (!navigator.onLine) return;

    // 🔥 FIX CRITICO: Scudo Anti-Orfani per Firebase
    if (!numeroScheda || String(numeroScheda).trim() === '') return;

    const url = `${FIREBASE_URL}/clienti/${numeroScheda}/fidelity.json`;
    const payload = {
        punti: nuoviPunti,
        ultima_operazione: dataOperazione
    };

    try {
        await fetch(url, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
    } catch (e) {
        console.warn("Sincronizzazione Firebase PATCH fallita:", e);
    }
}

// 2. Crea il log "Messaggio" con lo storico della transazione
async function firebasePushNotifiche(numeroScheda, saldoIniziale, puntiCaricati, puntiScaricati, saldoPunti, bonus) {
    if (!navigator.onLine) return;

    // 🔥 FIX CRITICO: Scudo Anti-Orfani per Firebase
    if (!numeroScheda || String(numeroScheda).trim() === '') return;

    const url = `${FIREBASE_URL}/clienti/${numeroScheda}/messaggi.json`;
    const oggi = new Date();

    const payload = {
        saldo_iniziale: saldoIniziale.toFixed(2),
        punti_caricati: puntiCaricati.toFixed(2),
        punti_scaricati: puntiScaricati.toFixed(2),
        saldo_punti: saldoPunti.toFixed(2),
        bonus: bonus.toFixed(2),
        data: `${String(oggi.getDate()).padStart(2, '0')}/${String(oggi.getMonth() + 1).padStart(2, '0')}/${oggi.getFullYear()}`,
        ora: `${String(oggi.getHours()).padStart(2, '0')}:${String(oggi.getMinutes()).padStart(2, '0')}:${String(oggi.getSeconds()).padStart(2, '0')}`,
        timestamp: Math.floor(oggi.getTime() / 1000)
    };

    try {
        await fetch(url, {
            method: 'POST', // POST crea un nuovo ID univoco dentro la cartella messaggi
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
    } catch (e) {
        console.warn("Sincronizzazione Firebase POST fallita:", e);
    }
}

// ==========================================
// ⚙️ LOGICA IMPOSTAZIONI E BACKUP
// ==========================================

// 1. Esportazione CSV (Leggibile da Excel)
window.esportaDatiCSV = async function (tabella) {
    let dati = await getAll(tabella);
    if (dati.length === 0) {
        mostraAvvisoModale(`Nessun dato presente in "${tabella}".`);
        return;
    }

    let csvContent = "data:text/csv;charset=utf-8,";

    // Crea intestazioni
    let keys = Object.keys(dati[0]);
    // Filtra l'array complesso degli articoli per le vendite, per non spaccare il CSV
    if (tabella === 'vendite') keys = keys.filter(k => k !== 'ARTICOLI');

    csvContent += keys.join(";") + "\r\n";

    // Aggiungi i dati
    dati.forEach(row => {
        let rowData = keys.map(k => {
            let cella = row[k] !== undefined && row[k] !== null ? row[k].toString() : "";
            // Pulisci i dati da virgole o a capo che rompono il CSV
            cella = cella.replace(/"/g, '""').replace(/\n/g, ' ');
            return `"${cella}"`;
        });
        csvContent += rowData.join(";") + "\r\n";
    });

    // Avvia download
    let encodedUri = encodeURI(csvContent);
    let link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `export_${tabella}_${getOggiString()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    mostraAvvisoModale(`Esportazione di ${dati.length} righe completata con successo!`);
};

// 2. Backup Totale in formato JSON (Ripristinabile)
window.esportaBackupCompleto = async function () {
    let backup = {
        clienti: await getAll('clienti'),
        vendite: await getAll('vendite'),
        magazzino: await getAll('magazzino'),
        movimenti_cassa: await getAll('movimenti_cassa')
    };

    let dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(backup, null, 2));
    let link = document.createElement("a");
    link.setAttribute("href", dataStr);
    link.setAttribute("download", `Backup_Gestionale_${getOggiString()}.json`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    mostraAvvisoModale("Backup Totale salvato sul tuo computer/dispositivo!");
};

// 2.5 Ripristino Backup Totale da file JSON
window.importaBackupJSON = function (event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async function (e) {
        try {
            let backup = JSON.parse(e.target.result);
            
            let tx = db.transaction(['clienti', 'vendite', 'magazzino', 'movimenti_cassa'], 'readwrite');
            
            if (backup.clienti) backup.clienti.forEach(c => tx.objectStore('clienti').put(c));
            if (backup.vendite) backup.vendite.forEach(v => tx.objectStore('vendite').put(v));
            if (backup.magazzino) backup.magazzino.forEach(m => tx.objectStore('magazzino').put(m));
            if (backup.movimenti_cassa) backup.movimenti_cassa.forEach(mc => tx.objectStore('movimenti_cassa').put(mc));

            tx.oncomplete = () => {
                mostraAvvisoModale("✅ Backup ripristinato con successo!<br>Tutti i dati sono stati caricati nel sistema.");
                event.target.value = ''; // Resetta l'input per permettere un nuovo caricamento
            };
        } catch (error) {
            mostraAvvisoModale("❌ Errore durante la lettura del file. Assicurati che sia un file JSON di backup valido generato dal sistema.");
            console.error(error);
        }
    };
    reader.readAsText(file);
};

// 3. Sistema di Reset (Svuota Archivi)
let tipoResetSelezionato = "";

window.preparaReset = function (tipo) {
    tipoResetSelezionato = tipo;
    let msg = "";
    if (tipo === 'vendite') {
        msg = "Stai per <b>CANCELLARE TUTTO LO STORICO DELLE VENDITE E DEI MOVIMENTI DI CASSA</b>.<br><br>Magazzino e Clienti non verranno toccati.<br>Procedere?";
    } else if (tipo === 'tutto') {
        msg = "Stai per <b>AZZERARE COMPLETAMENTE IL GESTIONALE</b>.<br>Vendite, Clienti, Magazzino e Movimenti verranno eliminati definitivamente.<br><br>Consigliamo di fare prima un Backup Totale. Procedere?";
    }
    document.getElementById('msg-conferma-reset').innerHTML = msg;
    apriModale('modal-conferma-reset');
};

window.eseguiResetDatabase = async function () {
    chiudiModale('modal-conferma-reset');
    chiudiModale('modal-impostazioni');

    if (tipoResetSelezionato === 'vendite' || tipoResetSelezionato === 'tutto') {
        let tx = db.transaction(['vendite', 'movimenti_cassa'], 'readwrite');
        tx.objectStore('vendite').clear();
        tx.objectStore('movimenti_cassa').clear();
    }

    if (tipoResetSelezionato === 'tutto') {
        let tx2 = db.transaction(['clienti', 'magazzino'], 'readwrite');
        tx2.objectStore('clienti').clear();
        tx2.objectStore('magazzino').clear();
    }

    mostraAvvisoModale("Operazione di pulizia database completata con successo.<br>La pagina verrà ricaricata.");

    setTimeout(() => {
        window.location.reload();
    }, 3000);
};

// 4. Importazione dati da CSV (Excel salvato come CSV)
window.gestisciImportazioneCSV = function (event, tabella) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async function (e) {
        const text = e.target.result;
        // Dividi il testo in righe
        const righe = text.split('\n').filter(riga => riga.trim() !== '');

        if (righe.length <= 1) {
            mostraAvvisoModale("Il file CSV sembra vuoto o manca delle intestazioni.");
            event.target.value = ''; 
            return;
        }

        const separatore = righe[0].includes(';') ? ';' : ',';
        const intestazioni = righe[0].split(separatore).map(h => h.trim().replace(/"/g, '').toLowerCase());

        let conteggioAggiunti = 0;
        let venditeDaSalvare = [];
        let movimentiDaSalvare = []; // 🔥 NUOVO: Raccoglitore per i Movimenti di Cassa (Spese/Distributore)
        let venditaCorrente = null;

        for (let i = 1; i < righe.length; i++) {
            const valori = righe[i].split(separatore).map(v => v.trim().replace(/"/g, ''));
            if (valori.length < intestazioni.length - 1) continue; 

            let record = {};
            intestazioni.forEach((chiave, index) => {
                record[chiave] = valori[index] || "";
            });

            // IMPORTAZIONE CLIENTI
            if (tabella === 'clienti') {
                let nome = record.nome || record.cliente || "CLIENTE SENZA NOME";
                let telefono = record.telefono || record.cellulare || record.tel || "";
                let scheda = record.scheda || record.card || record.codice || ("200" + Math.floor(Math.random() * 10000000000).toString().padStart(10, '0'));

                let strPunti = String(record.punti || "0").replace(/[^0-9,\-]/g, '').replace(',', '.');
                let punti = parseFloat(strPunti) || 0;
                let bonus = Math.floor(punti / 100) * 10;

                let nuovoCliente = { scheda: scheda, nome: nome.toUpperCase(), telefono: telefono, punti: punti, bonus: bonus, dataUltimaOperazione: getOggiString() };
                await updateCliente(nuovoCliente);
                conteggioAggiunti++;
            }
            // IMPORTAZIONE MAGAZZINO
            else if (tabella === 'magazzino') {
                let codice = record.codice || record.barcode || record.ean || ("210" + Math.floor(Math.random() * 10000000000).toString().padStart(10, '0'));
                let descrizione = record.descrizione || record.articolo || record.nome || "ARTICOLO SCONOSCIUTO";
                let categoria = record.categoria || record.reparto || "VARIE";

                let strGiac = String(record.giacenza || record.quantita || "0").replace(/[^0-9,\-]/g, '');
                let strVen = String(record.prezzo || record.prezzovendita || record.listino || "0").replace(/[^0-9,\-]/g, '').replace(',', '.');
                let strAcq = String(record.prezzoacquisto || record.costo || "0").replace(/[^0-9,\-]/g, '').replace(',', '.');

                let giacenza = parseInt(strGiac) || 0;
                let prezzoVen = parseFloat(strVen) || 0;
                let prezzoAcq = parseFloat(strAcq) || 0;

                let tx = db.transaction('magazzino', 'readwrite');
                let store = tx.objectStore('magazzino');
                let nuovoProdotto = { codice: codice, descrizione: descrizione.toUpperCase(), categoria: categoria.toUpperCase(), giacenza: giacenza, prezzoAcquisto: prezzoAcq, prezzo: prezzoVen, tipo: "PZ" };

                store.put(nuovoProdotto);

                if (typeof salvaProdottoCloud === "function") {
                    salvaProdottoCloud(nuovoProdotto);
                }

                conteggioAggiunti++;
            }
            // IMPORTAZIONE STORICO VENDITE
            else if (tabella === 'vendite') {
                let isMultipla = (record.multiple || "").toLowerCase() === 'c';
                let dataExcel = record.giorno || record.data || getOggiString();

                if (dataExcel.includes('/')) {
                    let parti = dataExcel.split('/');
                    if (parti.length === 3) {
                        let anno = parti[2].length === 2 ? "20" + parti[2] : parti[2];
                        let mese = parti[1].padStart(2, '0');
                        let giorno = parti[0].padStart(2, '0');
                        dataExcel = `${anno}-${mese}-${giorno}`;
                    }
                }

                let ora = record.ora || "12:00";
                let cliente = record.cliente || record.nome || "Nessuno";
                let desc = record.descrizione || record.articoli || "VENDITA STORICA EXCEL";
                let cat = (record['categ.'] || record.categoria || record.categ || "STORICO").toUpperCase();
                
                let importoMerce = parseFloat(String(record.importo || "0").replace(/[^0-9,\-]/g, '').replace(',', '.')) || 0;
                let contanti = parseFloat(String(record.contanti || "0").replace(/[^0-9,\-]/g, '').replace(',', '.')) || 0;

                // 🌟 FIX: Intercettiamo le Uscite di Cassa
                if (cat === 'USCITA' || cliente.toUpperCase() === 'USCITA DI CASSA') {
                    if (venditaCorrente) { venditeDaSalvare.push(venditaCorrente); venditaCorrente = null; }
                    movimentiDaSalvare.push({
                        data: dataExcel,
                        ora: ora,
                        tipo: "USCITA",
                        importo: importoMerce > 0 ? importoMerce : contanti,
                        descrizione: desc
                    });
                    continue; // Salta il resto del ciclo, NON lo salva come vendita!
                }

                // 🌟 FIX: Intercettiamo l'Incasso del Distributore
                if (cat === 'DISTRIBUTORE' || cliente.toUpperCase() === 'INCASSO DISTRIBUTORE') {
                    if (venditaCorrente) { venditeDaSalvare.push(venditaCorrente); venditaCorrente = null; }
                    movimentiDaSalvare.push({
                        data: dataExcel,
                        ora: ora,
                        tipo: "ENTRATA",
                        importo: importoMerce > 0 ? importoMerce : contanti,
                        descrizione: desc
                    });
                    continue; // Salta il resto del ciclo, NON lo salva come vendita!
                }

                let qta = parseInt(String(record['q.tà'] || record.quantita || record.qta || "1").replace(/[^0-9,\-]/g, '')) || 1;
                let pos = parseFloat(String(record.pos || record.carta || "0").replace(/[^0-9,\-]/g, '').replace(',', '.')) || 0;

                let sIniz = parseFloat(String(record['s. iniz.'] || "0").replace(/[^0-9,\-]/g, '').replace(',', '.')) || 0;
                let pCaric = parseFloat(String(record['p. caric.'] || "0").replace(/[^0-9,\-]/g, '').replace(',', '.')) || 0;
                let pScaric = parseFloat(String(record['p. scaric.'] || "0").replace(/[^0-9,\-]/g, '').replace(',', '.')) || 0;
                let bonus = parseFloat(String(record.bonus || "0").replace(/[^0-9,\-]/g, '').replace(',', '.')) || 0;
                let sFin = parseFloat(String(record['s. fin.'] || "0").replace(/[^0-9,\-]/g, '').replace(',', '.')) || 0;

                let articoloCorrente = {
                    CODICE: "CSV-" + Math.floor(Math.random() * 10000000),
                    ARTICOLO: desc,
                    DESCRIZIONE: desc,
                    TIPO: "PZ",
                    IMPORTO: importoMerce,
                    QUANTITA: qta,
                    CATEGORIA: cat
                };

                let appartieneAStessaVendita = venditaCorrente &&
                    venditaCorrente.CLIENTE === cliente.toUpperCase() &&
                    venditaCorrente.GIORNO === dataExcel &&
                    venditaCorrente.ORA === ora &&
                    isMultipla;

                if (appartieneAStessaVendita) {
                    venditaCorrente.ARTICOLI.push(articoloCorrente);
                } else {
                    if (venditaCorrente) {
                        venditeDaSalvare.push(venditaCorrente);
                    }
                    venditaCorrente = {
                        CLIENTE: cliente.toUpperCase(),
                        GIORNO: dataExcel,
                        ORA: ora,
                        CONTANTI: contanti,
                        POS: pos,
                        PUNTI_CARICATI: pCaric,
                        PUNTI_SCARICATI: pScaric,
                        BONUS: bonus,
                        SALDO_PUNTI_INIZIALE: sIniz,
                        SALDO_PUNTI_FINALE: sFin,
                        ARTICOLI: [articoloCorrente]
                    };
                }
            }
        }

        // Salvataggio massivo
        if (tabella === 'vendite') {
            if (venditaCorrente) {
                venditeDaSalvare.push(venditaCorrente);
            }
            
            conteggioAggiunti = 0; // Azzera per ricalcolare il totale esatto di righe caricate

            if (venditeDaSalvare.length > 0) {
                let tx = db.transaction('vendite', 'readwrite');
                let store = tx.objectStore('vendite');
                venditeDaSalvare.forEach(v => store.add(v));
                conteggioAggiunti += venditeDaSalvare.length;
            }
            
            if (movimentiDaSalvare.length > 0) {
                let txMov = db.transaction('movimenti_cassa', 'readwrite');
                let storeMov = txMov.objectStore('movimenti_cassa');
                movimentiDaSalvare.forEach(m => storeMov.add(m));
                conteggioAggiunti += movimentiDaSalvare.length;
            }
        }

        mostraAvvisoModale(`✅ Importazione completata!<br><br>Sono stati elaborati e salvati <b>${conteggioAggiunti}</b> record nell'archivio ${tabella.toUpperCase()}.`);
        event.target.value = ''; 
    };

    reader.readAsText(file, 'UTF-8');
};

// 4.1. Salvataggio Impostazioni Personalizzate
const MSG_BASE_DEFAULT = "CHEMARIA FIDELITY\n\nCiao, {NOME}\n\nCard N: {SCHEDA}\n\n-------------------------\n* Saldo Iniziale: {SALDO_INIZIALE}\n\n* Punti Caricati: {PUNTI_CARICATI}\n\n* Punti Scaricati: {PUNTI_SCARICATI}\n\n* Saldo Punti: {PUNTI}\n\n* Bonus: € {BONUS}\n-------------------------\n\n{DATA}\n{ORA}";

window.caricaImpostazioniAvanzate = function () {
    // Carica PIN e Messaggio App
    let pinAttivo = localStorage.getItem('impostazioni_pin_attivo');
    document.getElementById('impostazioni-pin-toggle').checked = (pinAttivo !== 'false');

    let msgSalvato = localStorage.getItem('impostazioni_msg_template');
    if (!msgSalvato) msgSalvato = MSG_BASE_DEFAULT;
    document.getElementById('impostazioni-msg-template').value = msgSalvato;

    // Carica Dati Scontrino
    document.getElementById('imp-stampa-nome').value = localStorage.getItem('imp_stampa_nome') || "";
    document.getElementById('imp-stampa-indirizzo').value = localStorage.getItem('imp_stampa_indirizzo') || "";
    document.getElementById('imp-stampa-piva').value = localStorage.getItem('imp_stampa_piva') || "";
    document.getElementById('imp-stampa-footer').value = localStorage.getItem('imp_stampa_footer') || "Grazie e Arrivederci!";
};

window.salvaImpostazioniAvanzate = function () {
    // Salva PIN e Messaggio
    let pinAttivo = document.getElementById('impostazioni-pin-toggle').checked;
    let msg = document.getElementById('impostazioni-msg-template').value.trim();
    if (msg === "") msg = MSG_BASE_DEFAULT;

    localStorage.setItem('impostazioni_pin_attivo', pinAttivo ? 'true' : 'false');
    localStorage.setItem('impostazioni_msg_template', msg);

    // Salva Dati Scontrino
    localStorage.setItem('imp_stampa_nome', document.getElementById('imp-stampa-nome').value.trim());
    localStorage.setItem('imp_stampa_indirizzo', document.getElementById('imp-stampa-indirizzo').value.trim());
    localStorage.setItem('imp_stampa_piva', document.getElementById('imp-stampa-piva').value.trim());
    localStorage.setItem('imp_stampa_footer', document.getElementById('imp-stampa-footer').value.trim());

    // Usa rigorosamente la modale, mai l'alert
    mostraAvvisoModale("Impostazioni salvate con successo!");
};

// ==========================================
// ✏️ LOGICA EDITOR AVANZATO MESSAGGI
// ==========================================
// 1. Apre l'editor caricando il testo attuale
window.apriEditorMessaggio = function () {
    let testoAttuale = document.getElementById('impostazioni-msg-template').value;
    let editor = document.getElementById('editor-messaggio-textarea');
    editor.value = testoAttuale;

    // 🔥 CHIUDE il template sottostante per pulizia visiva
    chiudiModale('modal-impostazioni-whatsapp');
    apriModale('modal-editor-messaggio');

    // Mette a fuoco la casella di testo
    setTimeout(() => {
        editor.focus();
        // Sposta il cursore alla fine del testo
        editor.selectionStart = editor.selectionEnd = editor.value.length;
    }, 100);
};

// 2. Inserimento intelligente della variabile alla posizione del cursore
window.inserisciVariabileMessaggio = function (variabile) {
    const editor = document.getElementById('editor-messaggio-textarea');

    // Ottieni la posizione attuale del cursore
    const inizio = editor.selectionStart;
    const fine = editor.selectionEnd;
    const testo = editor.value;

    // Incolla la variabile esattamente dove si trovava il cursore
    editor.value = testo.substring(0, inizio) + variabile + testo.substring(fine);

    // Ripristina il focus e sposta il cursore subito dopo la variabile appena inserita
    editor.focus();
    const nuovaPosizione = inizio + variabile.length;
    editor.selectionStart = editor.selectionEnd = nuovaPosizione;
};

// 3. Conferma le modifiche e aggiorna l'anteprima
window.confermaEditorMessaggio = function () {
    let nuovoTesto = document.getElementById('editor-messaggio-textarea').value;

    // Aggiorna la casella di anteprima nelle impostazioni
    document.getElementById('impostazioni-msg-template').value = nuovoTesto;

    // 🔥 Chiude l'editor e RIAPRE il template con il testo aggiornato!
    chiudiModale('modal-editor-messaggio');
    apriModale('modal-impostazioni-whatsapp');
};

window.apriImpostazioniWhatsApp = function () {
    let msgSalvato = localStorage.getItem('impostazioni_msg_template') || MSG_BASE_DEFAULT;
    document.getElementById('impostazioni-msg-template').value = msgSalvato;

    chiudiModale('modal-impostazioni-menu');
    apriModale('modal-impostazioni-whatsapp');
};

window.salvaImpostazioniWhatsApp = function () {
    let nuovoMsg = document.getElementById('impostazioni-msg-template').value;
    localStorage.setItem('impostazioni_msg_template', nuovoMsg);

    mostraAvvisoModale("Template WhatsApp aggiornato con successo!");
    chiudiModale('modal-impostazioni-whatsapp');
    apriModale('modal-impostazioni-menu');
};

// ==========================================
// 🔫 LOGICA LETTORE BARCODE GLOBALE (OMNIDIREZIONALE)
// ==========================================
let bufferScanner = "";
let ultimoTastoScanner = 0;

document.addEventListener('keypress', async function (e) {
    // 1. Controlla se siamo nella Cassa (il menu principale deve essere chiuso)
    let menuAperto = document.getElementById('modal-menu-principale').style.display !== 'none';
    if (menuAperto) return;

    // 2. Se l'utente sta scrivendo in un altro campo (es. ricerca cliente, calcolatrice), ignora lo scanner globale
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
        return;
    }

    let tempoAttuale = Date.now();

    // 3. Se è passato troppo tempo (più di 50 millisecondi) dall'ultimo tasto, 
    // significa che è un umano che digita sulla tastiera, non uno scanner laser. Azzeriamo la memoria!
    if (tempoAttuale - ultimoTastoScanner > 50) {
        bufferScanner = "";
    }

    // 4. Se lo scanner invia "Enter" (Invio) alla fine del codice
    if (e.key === 'Enter') {
        if (bufferScanner.length > 3) {
            // Abbiamo un codice a barre valido! Lo cerchiamo in magazzino
            const magazzinoCompleto = await getAll('magazzino');
            const prodotto = magazzinoCompleto.find(p => p.codice === bufferScanner);

            if (prodotto) {
                aggiungiProdotto(prodotto);
            } else {
                mostraAvvisoModale(`<b>PRODOTTO SCONOSCIUTO</b><br>Nessun articolo trovato con il codice: ${bufferScanner}`);
            }
            bufferScanner = ""; // Svuota la memoria per il prossimo codice
        }
    } else {
        // Aggiunge la lettera o il numero alla memoria temporanea
        bufferScanner += e.key;
    }

    ultimoTastoScanner = tempoAttuale;
});

// ==========================================
// 👤 GESTIONE DIPENDENTI E OPERATORI
// ==========================================
let operatoreAttivo = localStorage.getItem('operatore_attivo') || "Admin";
let listaOperatori = JSON.parse(localStorage.getItem('lista_operatori')) || ["Admin"];

// Avvio: imposta il nome nella barra
document.getElementById('label-operatore').textContent = operatoreAttivo;

window.apriModaleOperatore = function () {
    let html = "";
    listaOperatori.forEach(op => {
        let isAttivo = (op === operatoreAttivo);
        html += `<button class="btn-modal ${isAttivo ? 'btn-verde' : 'btn-grigio'}" style="text-align: left; font-size: 1.8vh; padding: 12px; display: flex; justify-content: space-between;" onclick="selezionaOperatore('${op}')"><b>${op}</b> <span>${isAttivo ? '✅ ATTIVO' : ''}</span></button>`;
    });
    document.getElementById('lista-bottoni-operatori').innerHTML = html;
    apriModale('modal-operatore');
};

window.selezionaOperatore = function (nome) {
    operatoreAttivo = nome;
    localStorage.setItem('operatore_attivo', nome);
    document.getElementById('label-operatore').textContent = nome;
    chiudiModale('modal-operatore');
    mostraMessaggio(`OPERATORE ATTIVO: ${nome}`);
};

window.aggiungiOperatore = function () {
    let nome = document.getElementById('nuovo-nome-operatore').value.trim();
    if (nome && !listaOperatori.includes(nome)) {
        listaOperatori.push(nome);
        localStorage.setItem('lista_operatori', JSON.stringify(listaOperatori));
        document.getElementById('nuovo-nome-operatore').value = "";
        selezionaOperatore(nome); // Lo attiva direttamente
    }
};

// ==========================================
// 📊 MOTORE DASHBOARD STATISTICHE
// ==========================================
window.calcolaStatistiche = async function () {
    const periodoScelto = document.getElementById('stat-periodo').value;
    const tutteLeVendite = await getAll('vendite');

    // 1. Filtro Data
    let venditeFiltrate = [];
    let oggi = new Date();
    let dataOggiStr = getOggiString(); // formato YYYY-MM-DD

    tutteLeVendite.forEach(v => {
        let dataVendita = new Date(v.GIORNO);
        let includi = false;

        if (periodoScelto === 'oggi' && v.GIORNO === dataOggiStr) includi = true;
        else if (periodoScelto === 'ieri') {
            let ieri = new Date(oggi); ieri.setDate(ieri.getDate() - 1);
            if (v.GIORNO === ieri.toISOString().split('T')[0]) includi = true;
        }
        else if (periodoScelto === 'settimana') {
            let limite = new Date(oggi); limite.setDate(limite.getDate() - 7);
            if (dataVendita >= limite) includi = true;
        }
        else if (periodoScelto === 'mese') {
            if (dataVendita.getMonth() === oggi.getMonth() && dataVendita.getFullYear() === oggi.getFullYear()) includi = true;
        }
        else if (periodoScelto === 'tutto') includi = true;

        if (includi) venditeFiltrate.push(v);
    });

    // 2. Elaborazione Metriche Base
    let incassoTotale = 0;
    let numeroScontrini = venditeFiltrate.length;
    let prodottiVenduti = {};
    let incassiOperatori = {};

    venditeFiltrate.forEach(v => {
        let totaleScontrino = v.POS + v.CONTANTI;
        incassoTotale += totaleScontrino;

        // Calcolo Operatori
        let op = v.OPERATORE || "Sconosciuto";
        if (!incassiOperatori[op]) incassiOperatori[op] = 0;
        incassiOperatori[op] += totaleScontrino;

        // Calcolo Prodotti
        if (v.ARTICOLI) {
            v.ARTICOLI.forEach(art => {
                if (!prodottiVenduti[art.DESCRIZIONE]) {
                    prodottiVenduti[art.DESCRIZIONE] = { qta: 0, incasso: 0, categoria: art.CATEGORIA };
                }
                prodottiVenduti[art.DESCRIZIONE].qta += art.QUANTITA;
                prodottiVenduti[art.DESCRIZIONE].incasso += (art.IMPORTO * art.QUANTITA);
            });
        }
    });

    let mediaScontrino = numeroScontrini > 0 ? (incassoTotale / numeroScontrini) : 0;

    // 3. Stampa Metriche
    document.getElementById('stat-tot-incasso').textContent = `€ ${incassoTotale.toLocaleString('it-IT', { minimumFractionDigits: 2 })}`;
    document.getElementById('stat-tot-scontrini').textContent = numeroScontrini;
    document.getElementById('stat-media-scontrino').textContent = `€ ${mediaScontrino.toLocaleString('it-IT', { minimumFractionDigits: 2 })}`;

    // 4. Stampa Operatori (ordinati per incasso)
    let operatoriArray = Object.keys(incassiOperatori).map(op => ({ nome: op, incasso: incassiOperatori[op] }));
    operatoriArray.sort((a, b) => b.incasso - a.incasso);

    let htmlOperatori = "";
    operatoriArray.forEach(op => {
        let percentuale = incassoTotale > 0 ? ((op.incasso / incassoTotale) * 100).toFixed(0) : 0;
        htmlOperatori += `
                    <div style="background: rgba(255,255,255,0.05); padding: 10px; border-radius: 6px; display: flex; justify-content: space-between; align-items: center; border-left: 4px solid #00cc66;">
                        <div>
                            <div style="color: #fff; font-weight: bold; font-size: 1.6vh;">👤 ${op.nome}</div>
                            <div style="color: #8888bb; font-size: 1.3vh;">${percentuale}% del totale</div>
                        </div>
                        <div style="color: #00cc66; font-weight: bold; font-size: 1.8vh;">€ ${op.incasso.toLocaleString('it-IT', { minimumFractionDigits: 2 })}</div>
                    </div>`;
    });
    if (htmlOperatori === "") htmlOperatori = "<div style='color:#8888bb;'>Nessuna vendita nel periodo selezionato.</div>";
    document.getElementById('stat-lista-operatori').innerHTML = htmlOperatori;

    // 5. Stampa Prodotti Top 50 (ordinati per quantità venduta)
    let prodottiArray = Object.keys(prodottiVenduti).map(nome => ({ nome: nome, qta: prodottiVenduti[nome].qta, incasso: prodottiVenduti[nome].incasso, cat: prodottiVenduti[nome].categoria }));
    prodottiArray.sort((a, b) => b.qta - a.qta);
    prodottiArray = prodottiArray.slice(0, 50); // Prendi solo i primi 50

    let htmlProdotti = "";
    prodottiArray.forEach((p, index) => {
        let medaglia = index === 0 ? "🥇" : index === 1 ? "🥈" : index === 2 ? "🥉" : `<b>${index + 1}.</b>`;
        htmlProdotti += `
                    <div class="crm-list-item" style="display: flex; justify-content: space-between; align-items: center;">
                        <div style="display: flex; align-items: center; gap: 15px;">
                            <div style="font-size: 2vh; width: 30px; text-align: center;">${medaglia}</div>
                            <div>
                                <div style="color: #ffffff; font-weight: bold; font-size: 1.6vh;">${p.nome}</div>
                                <div style="color: #b3d9ff; font-size: 1.3vh;">Cat: ${p.cat}</div>
                            </div>
                        </div>
                        <div style="text-align: right;">
                            <div style="color: #ffcc00; font-weight: bold; font-size: 1.8vh;">${p.qta} Pz.</div>
                            <div style="color: #4d88ff; font-size: 1.4vh;">Incasso: € ${p.incasso.toLocaleString('it-IT', { minimumFractionDigits: 2 })}</div>
                        </div>
                    </div>`;
    });
    if (htmlProdotti === "") htmlProdotti = "<div style='color:#8888bb; padding: 15px;'>Nessun prodotto venduto nel periodo selezionato.</div>";
    document.getElementById('stat-lista-prodotti').innerHTML = htmlProdotti;
};

// ==========================================
// 📡 TRASMISSIONE LIVE AL CRUSCOTTO REMOTO (VERSIONE COMPLETA)
// ==========================================
window.inviaVenditaLive = async function (record) {
    if (!navigator.onLine) return;

    let payload = {
        id: record.id,
        ora: record.ORA,
        operatore: record.OPERATORE || "Sconosciuto",
        totale: record.CONTANTI + record.POS,
        contanti: record.CONTANTI,
        pos: record.POS,
        tipo: "VENDITA" // Aggiunta etichetta per il cruscotto
    };

    const url = `${FIREBASE_URL}/vendite_live/${record.GIORNO}/${record.id}.json`;
    try { await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); } catch (e) { }
};

window.eliminaVenditaLive = async function (giorno, idVendita) {
    if (!navigator.onLine) return;
    const url = `${FIREBASE_URL}/vendite_live/${giorno}/${idVendita}.json`;
    try { await fetch(url, { method: 'DELETE' }); } catch (e) { }
};

window.inviaMovimentoLive = async function (movimento) {
    if (!navigator.onLine) return;

    let payload = {
        id: "MOV_" + movimento.id,
        ora: movimento.ora,
        operatore: operatoreAttivo || "Sconosciuto",
        totale: movimento.importo,
        tipo: movimento.tipo, // 'ENTRATA' o 'USCITA'
        descrizione: movimento.descrizione
    };

    const url = `${FIREBASE_URL}/vendite_live/${movimento.data}/MOV_${movimento.id}.json`;
    try { await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); } catch (e) { }
};

// Aggancio la rimozione del movimento dal Cloud nel sistema universale
let f_eseguiEliminazioneUniversale = window.eseguiEliminazioneUniversale;
window.eseguiEliminazioneUniversale = async function () {
    if (tipoEliminazione === 'MOVIMENTO') {
        let mov = await getRecordById('movimenti_cassa', idDaEliminare);
        await deleteRecord('movimenti_cassa', idDaEliminare);

        // 🔥 Rimuovi dal cruscotto Cloud
        if (mov && navigator.onLine) {
            fetch(`${FIREBASE_URL}/vendite_live/${mov.data}/MOV_${idDaEliminare}.json`, { method: 'DELETE' }).catch(e => console.log(e));
        }

        await popolaRegistroCassa();
        chiudiModale('modal-conferma-elimina');
        mostraMessaggio("MOVIMENTO ELIMINATO CON SUCCESSO");
    } else {
        f_eseguiEliminazioneUniversale(); // Chiama la vecchia funzione per Clienti, Prodotti e Scontrini
    }
};

window.eliminaVenditaLive = async function (giorno, idVendita) {
    if (!navigator.onLine) return;

    // Indirizzo del dato da eliminare
    const url = `${FIREBASE_URL}/vendite_live/${giorno}/${idVendita}.json`;

    try {
        // Usiamo DELETE per rimuovere fisicamente il nodo
        let response = await fetch(url, {
            method: 'DELETE'
        });

        if (response.ok) {
            console.log(`✅ ELIMINAZIONE FIREBASE RIUSCITA: Incasso stornato dal cloud!`);
        } else {
            console.error("❌ ERRORE FIREBASE HTTP:", response.status);
        }
    } catch (e) {
        console.error("❌ ERRORE FIREBASE (Eliminazione fallita):", e);
    }
};

// ==========================================
// ☁️ CLOUD-SYNC: MOTORE BIDIREZIONALE CLIENTI
// ==========================================

// 1. SPINGE il cliente sul Cloud (quando lo crei o lo modifichi)
window.salvaClienteCloud = async function (cliente) {
    if (!navigator.onLine) return;

    // Scudo Anti-Orfani
    if (!cliente || !cliente.scheda || cliente.scheda.trim() === '') return;

    cliente.timestamp_sync = Date.now();

    // 🔥 FIX FONDAMENTALE (Salvataggio Chat): 
    // Creiamo una copia esatta del cliente ma "scolleghiamo" la cartella messaggi prima di inviarla.
    // In questo modo il PATCH aggiornerà nome, punti e notifiche, lasciando intatta la cronologia chat su Firebase!
    let payloadDaInviare = { ...cliente };
    delete payloadDaInviare.messaggi;

    const url = `${FIREBASE_URL}/clienti/${cliente.scheda}.json`;

    try {
        await fetch(url, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payloadDaInviare) // Inviamo il payload pulito
        });
        console.log(`☁️ Sync UP: Cliente ${cliente.nome} aggiornato sul cloud.`);
    } catch (e) {
        console.error("Errore salvataggio cloud cliente:", e);
    }
};

// 2. TIRA GIÙ i clienti dal Cloud (all'avvio e in background)
window.scaricaClientiDalCloud = async function () {
    if (!navigator.onLine) return;

    const url = `${FIREBASE_URL}/clienti.json`;

    try {
        let response = await fetch(url);
        let clientiCloud = await response.json();

        if (clientiCloud) {
            let dbClientiLocali = await getAll('clienti');
            let tx = db.transaction('clienti', 'readwrite');
            let store = tx.objectStore('clienti');
            let aggiornamentiFatti = 0;

            // Confrontiamo il Cloud con il Locale
            Object.keys(clientiCloud).forEach(numeroScheda => {
                let clienteCloud = clientiCloud[numeroScheda];

                // 🌟 FIX FONDAMENTALE: Ignora i vecchi dati parziali di Firebase
                // Se il record non ha il numero di scheda o il nome, è un vecchio residuo e lo saltiamo!
                if (!clienteCloud || !clienteCloud.scheda || !clienteCloud.nome) {
                    return;
                }

                // 1. PRIMA DI TUTTO definiamo il clienteLocale (CERCA NEL DB LOCALE)
                let clienteLocale = dbClientiLocali.find(c => c.scheda === clienteCloud.scheda);
                let chatNotificata = false;

                // 2. ORA controlliamo la chat (perché clienteLocale adesso esiste!)
                if (clienteCloud.messaggi) {
                    let messaggiArray = Object.values(clienteCloud.messaggi);
                    let nuoviMessaggi = messaggiArray.filter(m =>
                        m.tipo === 'chat' &&
                        m.mittente === 'cliente' &&
                        m.timestamp > (clienteLocale?.ultima_lettura_chat || 0)
                    );

                    if (nuoviMessaggi.length > 0) {
                        // Prepariamo il nome in modo sicuro per evitare errori se contiene apostrofi (es. D'Amico)
                        let nomeSicuro = clienteCloud.nome.replace(/'/g, "\\'");

                        // Disegniamo la notifica con il nuovo super-bottone integrato
                        mostraAvvisoModale(`
                            🔔 Hai <b>${nuoviMessaggi.length}</b> nuovo/i messaggio/i in chat da:<br><br>
                            <span style="font-size: 2.5vh; color: #ff3366;"><b>${clienteCloud.nome}</b></span><br><br>
                            <button class="btn-modal" style="background-color: #ff3366; border: none; border-radius: 5px; color: white; width: 100%; margin-top: 15px; padding: 12px; font-weight: bold; font-size: 2vh; cursor: pointer;" onclick="apriChatDiretta('${clienteCloud.scheda}', '${nomeSicuro}')">💬 RISPONDI ORA</button>
                        `);

                        // Segniamo che abbiamo mostrato la notifica
                        if (clienteLocale) {
                            clienteLocale.ultima_lettura_chat = Date.now();
                            chatNotificata = true;
                        }
                    }
                }

                // 3. REGOLA D'ORO: Se non esiste in locale, o se quello sul cloud ha un timbro orario PIÙ RECENTE, scaricalo e sovrascrivi!
                let nonEsiste = !clienteLocale;
                let cloudPiuRecente = clienteLocale && clienteCloud.timestamp_sync && (!clienteLocale.timestamp_sync || clienteCloud.timestamp_sync > clienteLocale.timestamp_sync);

                if (nonEsiste || cloudPiuRecente) {
                    // Se stiamo sovrascrivendo con il cloud, conserviamo il timbro di lettura appena messo!
                    if (chatNotificata) clienteCloud.ultima_lettura_chat = clienteLocale.ultima_lettura_chat;
                    store.put(clienteCloud);
                    aggiornamentiFatti++;
                } else if (chatNotificata) {
                    // Se non ci sono altri dati da aggiornare dal cloud, ma abbiamo solo mostrato la notifica, salviamo la lettura locale.
                    store.put(clienteLocale);
                    aggiornamentiFatti++;
                }
            });

            if (aggiornamentiFatti > 0) {
                console.log(`☁️ Sync DOWN: Scaricati e aggiornati ${aggiornamentiFatti} clienti dal cloud.`);
                // Aggiorna la tabella a schermo se l'utente ha la modale aperta (nessun alert di sistema)
                if (document.getElementById('modal-gestione-clienti').style.display !== 'none') {
                    crmCaricaLista();
                }
            }
        }
    } catch (e) {
        console.error("Errore download cloud clienti:", e);
    }
};

// ==========================================
// ☁️ CLOUD-SYNC: MOTORE BIDIREZIONALE MAGAZZINO
// ==========================================

// 1. SPINGE il prodotto sul Cloud (Creazione / Modifica)
window.salvaProdottoCloud = async function (prodotto) {
    if (!navigator.onLine) return;

    prodotto.timestamp_sync = Date.now(); // Timbro orario
    const url = `${FIREBASE_URL}/magazzino/${prodotto.codice}.json`;

    try {
        await fetch(url, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(prodotto)
        });
        console.log(`☁️ Sync UP: Prodotto [${prodotto.codice}] inviato al cloud.`);
    } catch (e) {
        console.error("Errore salvataggio cloud prodotto:", e);
    }
};

// 2. TIRA GIÙ i prodotti dal Cloud
window.scaricaMagazzinoDalCloud = async function () {
    if (!navigator.onLine) return;

    const url = `${FIREBASE_URL}/magazzino.json`;

    try {
        let response = await fetch(url);
        let magazzinoCloud = await response.json();

        if (magazzinoCloud) {
            let dbMagazzinoLocale = await getAll('magazzino');
            let tx = db.transaction('magazzino', 'readwrite');
            let store = tx.objectStore('magazzino');
            let aggiornamentiFatti = 0;

            Object.keys(magazzinoCloud).forEach(codice => {
                let prodCloud = magazzinoCloud[codice];

                // Ignora dati corrotti
                if (!prodCloud || !prodCloud.codice || !prodCloud.descrizione) return;

                let prodLocale = dbMagazzinoLocale.find(p => p.codice === prodCloud.codice);

                let nonEsiste = !prodLocale;
                let cloudPiuRecente = prodLocale && prodCloud.timestamp_sync && (!prodLocale.timestamp_sync || prodCloud.timestamp_sync > prodLocale.timestamp_sync);

                if (nonEsiste || cloudPiuRecente) {
                    store.put(prodCloud);
                    aggiornamentiFatti++;
                }
            });

            if (aggiornamentiFatti > 0) {
                console.log(`☁️ Sync DOWN: Scaricati e aggiornati ${aggiornamentiFatti} prodotti dal cloud.`);
                // Aggiorna la UI se siamo nella schermata Magazzino
                if (document.getElementById('modal-magazzino').style.display !== 'none') {
                    magCaricaLista();
                }
            }
        }
    } catch (e) {
        console.error("Errore download cloud magazzino:", e);
    }
};

// ==========================================
// 📱 1. GENERAZIONE vCARD (QR CODE)
// ==========================================
window.generaQRvCard = function() {
    let nomeCompleto = document.getElementById('crm-nome').value.trim();
    let telefono = document.getElementById('crm-telefono').value.trim();

    if (nomeCompleto === '' || telefono === '') {
        mostraAvvisoModale("Per generare il QR Code devi prima inserire il Nome e il Telefono.");
        return;
    }

    let parti = nomeCompleto.split(' ');
    let nome = parti[0];
    let cognome = parti.length > 1 ? parti.slice(1).join(' ') : "";

    let vcard = `BEGIN:VCARD\nVERSION:3.0\nN:${cognome};${nome};;;\nFN:${nomeCompleto}\nTEL;TYPE=CELL:${telefono}\nEND:VCARD`;
    let url = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(vcard)}`;

    document.getElementById('qr-nome-cliente').textContent = nomeCompleto;
    document.getElementById('qr-tel-cliente').textContent = telefono;
            
    let img = document.getElementById('img-qr-vcard');
    let loader = document.getElementById('qr-loading');
            
    img.style.display = 'none';
    loader.style.display = 'block';
    img.onload = function() { loader.style.display = 'none'; img.style.display = 'block'; };
    img.src = url;

    apriModale('modal-qr-vcard');
};

// ==========================================
// 📲 2. INVIA CONTATTO AL PROPRIO WHATSAPP
// ==========================================
window.inviaContattoAlMioWhatsApp = function() {
    let nomeCompleto = document.getElementById('crm-nome').value.trim();
    let telefono = document.getElementById('crm-telefono').value.trim();

    if (nomeCompleto === '' || telefono === '') {
        mostraAvvisoModale("Per inviarti il contatto devi prima inserire il Nome e il Telefono.");
        return;
    }

    // 🛑 INSERISCI QUI IL TUO NUMERO DI TELEFONO PERSONALE (lascia il 39 davanti)
    let ilMioNumero = "393802837220"; 

    let messaggio = `👤 *Nuovo Contatto da Salvare*\nNome: ${nomeCompleto}\nTel: ${telefono}`;
    let url = `whatsapp://send?phone=${ilMioNumero}&text=${encodeURIComponent(messaggio)}`;
    window.open(url, '_blank');
};

// ==========================================
// 💬 3. APERTURA CHAT WHATSAPP DIRETTA CLIENTE
// ==========================================
window.apriWhatsAppDiretto = function() {
    let telefono = document.getElementById('crm-telefono').value.trim();
            
    if (telefono === '') {
        mostraAvvisoModale("Inserisci il numero di telefono per aprire WhatsApp.");
        return;
    }

    let numeroPulito = telefono.replace(/[^0-9]/g, '');
    if (!numeroPulito.startsWith('39') && numeroPulito.length <= 10) {
        numeroPulito = '39' + numeroPulito;
    }

    window.open(`whatsapp://send?phone=${numeroPulito}`, '_blank');
};

// ==========================================
// 💬 CHAT BIDIREZIONALE APP FIDELITY
// ==========================================
let chatClienteAttuale = null;
let chatSyncTimer = null;             // Timer per il controllo veloce
let numeroMessaggiInSchermo = 0;      // Contatore messaggi per evitare sfarfallii

window.apriSchermataChat = async function () {
    let scheda = document.getElementById('crm-codice').value.trim();
    let nome = document.getElementById('crm-nome').value.trim();

    if (!scheda) {
        mostraAvvisoModale("Seleziona o salva prima un cliente per aprire la chat.");
        return;
    }

    chatClienteAttuale = await getRecordById('clienti', scheda);
    if (!chatClienteAttuale) { chatClienteAttuale = { scheda: scheda, nome: nome }; }

    document.getElementById('chat-titolo').textContent = `💬 CHAT: ${nome}`;
    document.getElementById('chat-input-testo').value = '';

    apriModale('modal-chat-app');
    await ridisegnaTimelineChat();

    chatClienteAttuale.ultima_lettura_chat = Date.now();
    if (chatClienteAttuale.telefono) await updateCliente(chatClienteAttuale);

    // 🔥 Avvia il motore turbo per ricevere le risposte in tempo reale!
    avviaSyncChatVeloce();
};

// Funzione per chiudere e spegnere il turbo
window.chiudiSchermataChat = function () {
    if (chatSyncTimer) clearInterval(chatSyncTimer); // Spegne il motore
    chiudiModale('modal-chat-app');
};

window.ridisegnaTimelineChat = async function () {
    let timeline = document.getElementById('chat-timeline');

    // Mettiamo il caricamento solo se è la primissima apertura (schermo vuoto)
    if (timeline.innerHTML === '') {
        timeline.innerHTML = '<div style="text-align:center; color:#888; padding:20px;">Caricamento...</div>';
    }

    if (!navigator.onLine) {
        timeline.innerHTML = '<div style="text-align:center; color:#ff4d4d; padding:20px;">Sei offline. Impossibile caricare la chat.</div>';
        return;
    }

    try {
        let url = `${FIREBASE_URL}/clienti/${chatClienteAttuale.scheda}/messaggi.json`;
        let response = await fetch(url);
        let dati = await response.json();

        if (!dati) {
            timeline.innerHTML = '<div style="text-align:center; color:#888; padding:20px;">Nessun messaggio in cronologia. Inizia la conversazione!</div>';
            numeroMessaggiInSchermo = 0;
            return;
        }

        let messaggi = Object.values(dati).filter(m => m.tipo === 'chat');
        messaggi.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

        numeroMessaggiInSchermo = messaggi.length; // Aggiorna il contatore

        if (messaggi.length === 0) {
            timeline.innerHTML = '<div style="text-align:center; color:#888; padding:20px;">Nessun messaggio in cronologia. Inizia la conversazione!</div>';
            return;
        }

        timeline.innerHTML = ''; // Svuota la griglia per inserire i nuovi fumetti

        messaggi.forEach(m => {
            let div = document.createElement('div');
            let isNegozio = m.mittente === 'negozio';

            div.style.maxWidth = '80%';
            div.style.padding = '8px 12px';
            div.style.borderRadius = '12px';
            div.style.fontSize = '1.6vh';
            div.style.lineHeight = '1.4';
            div.style.position = 'relative';
            div.style.wordWrap = 'break-word';

            if (isNegozio) {
                div.style.alignSelf = 'flex-end';
                div.style.backgroundColor = '#0055cc';
                div.style.color = '#ffffff';
                div.style.borderBottomRightRadius = '2px';
            } else {
                div.style.alignSelf = 'flex-start';
                div.style.backgroundColor = '#334455';
                div.style.color = '#ffffff';
                div.style.borderBottomLeftRadius = '2px';
            }

            div.innerHTML = `
                        <div style="font-weight:bold; font-size:1.2vh; color: ${isNegozio ? '#99ccff' : '#00ffcc'}; margin-bottom: 3px;">
                            ${isNegozio ? 'Tu' : 'Cliente'} <span style="font-weight:normal; color:#aaa;">- ${m.data} ${m.ora}</span>
                        </div>
                        <div>${m.testo}</div>
                    `;
            timeline.appendChild(div);
        });

        // Scorri in fondo automaticamente
        timeline.scrollTop = timeline.scrollHeight;

    } catch (e) {
        timeline.innerHTML = '<div style="text-align:center; color:#ff4d4d; padding:20px;">Errore di connessione.</div>';
    }
};

// ==========================================
// 🚀 SCORCIATOIA: APRI CHAT DA NOTIFICA
// ==========================================
window.apriChatDiretta = function (scheda, nome) {
    // 1. Chiude tutte le modali aperte (incluso l'avviso del messaggio)
    document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');

    // 2. Precompila silenziosamente i campi del CRM necessari alla chat
    document.getElementById('crm-codice').value = scheda;
    document.getElementById('crm-nome').value = nome;

    // 3. Lancia istantaneamente l'interfaccia della chat
    apriSchermataChat();
};

// 🔥 IL MOTORE TURBO: Controlla in background ogni 3 secondi
window.avviaSyncChatVeloce = function () {
    if (chatSyncTimer) clearInterval(chatSyncTimer);

    chatSyncTimer = setInterval(async () => {
        let modal = document.getElementById('modal-chat-app');

        // Sicurezza assoluta: se la finestra viene chiusa o nascosta, il motore si spegne da solo
        if (!modal || modal.style.display === 'none' || modal.style.display === '') {
            clearInterval(chatSyncTimer);
            return;
        }

        if (!navigator.onLine || !chatClienteAttuale) return;

        try {
            // Controlla il Cloud senza far lampeggiare lo schermo
            let url = `${FIREBASE_URL}/clienti/${chatClienteAttuale.scheda}/messaggi.json`;
            let response = await fetch(url);
            let dati = await response.json();

            if (dati) {
                let messaggi = Object.values(dati).filter(m => m.tipo === 'chat');

                // C'è un nuovo messaggio che non abbiamo ancora disegnato?
                if (messaggi.length !== numeroMessaggiInSchermo) {
                    await ridisegnaTimelineChat();

                    // Aggiorna la lettura in locale per evitare che la notifica generale suoni per questo messaggio
                    chatClienteAttuale.ultima_lettura_chat = Date.now();
                    if (chatClienteAttuale.telefono) await updateCliente(chatClienteAttuale);
                }
            }
        } catch (e) { } // Ignora gli errori di connessione temporanei

    }, 3000); // 3000 millisecondi = 3 secondi (Puoi alzarlo o abbassarlo a piacimento)
};

window.inviaMessaggioChatApp = async function () {
    let input = document.getElementById('chat-input-testo');
    let testo = input.value.trim();

    if (!testo || !chatClienteAttuale) return;

    input.disabled = true; // Blocca input durante l'invio

    let url = `${FIREBASE_URL}/clienti/${chatClienteAttuale.scheda}/messaggi.json`;
    let oggi = new Date();

    // Il Payload esatto richiesto dall'App
    let payload = {
        tipo: "chat",
        mittente: "negozio",
        testo: testo,
        data: `${String(oggi.getDate()).padStart(2, '0')}/${String(oggi.getMonth() + 1).padStart(2, '0')}/${oggi.getFullYear()}`,
        ora: `${String(oggi.getHours()).padStart(2, '0')}:${String(oggi.getMinutes()).padStart(2, '0')}`,
        timestamp: Date.now()
    };

    try {
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        input.value = ''; // Pulisci testo
        await ridisegnaTimelineChat(); // Ricarica cronologia per vedere il nuovo messaggio

    } catch (e) {
        mostraAvvisoModale("Errore di connessione. Messaggio non inviato.");
    }

    input.disabled = false;
    input.focus();
};

// ==========================================
// ⏱️ AUTO-SYNC IN BACKGROUND (Ogni 60 secondi)
// ==========================================
setInterval(() => {
    // Scarica i dati in silenzio senza disturbare l'operatore
    if (navigator.onLine) {
        scaricaClientiDalCloud();
        scaricaMagazzinoDalCloud();
    }
}, 60000);

// ==========================================
// 🛡️ FILTRO GLOBALE CAMPI NUMERICI E IMPORTI
// ==========================================
document.querySelectorAll('input[inputmode="decimal"], input[inputmode="numeric"]').forEach(input => {
    input.addEventListener('input', function () {
        // Elimina in tempo reale qualsiasi lettera o simbolo non consentito.
        // Lascia passare solo: numeri (0-9), virgola (,), punto (.), simbolo euro (€), spazio e segno meno (-)
        this.value = this.value.replace(/[^0-9.,€ \-]/g, '');
    });
});

// Modifica il tasto "ESCI" della cassa (prima icona in alto a sx)
// affinché invece di chiudere l'app, torni al Menu Principale
const btnEsciCassa = document.querySelector('.tasto-fisico img[src*="esci.png"]').parentElement;
btnEsciCassa.onclick = function () {
    apriModale('modal-menu-principale');
};

// Aggiorna lo stato internet anche nel footer del menu
window.addEventListener('online', () => {
    document.getElementById('menu-status-web').textContent = "🟢 ONLINE";
    document.getElementById('menu-status-web').style.color = "#00cc66";
});
window.addEventListener('offline', () => {
    document.getElementById('menu-status-web').textContent = "🔴 OFFLINE";
    document.getElementById('menu-status-web').style.color = "#ff4d4d";
});

// Ascoltatori di eventi integrati nel browser per la rete
window.addEventListener('online', aggiornaStatoRete);
window.addEventListener('offline', aggiornaStatoRete);

// Controllo iniziale all'avvio
aggiornaStatoRete();
