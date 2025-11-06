// ¡IMPORTANTE! Reemplaza esto con tu propia clave de API de Gemini
const GEMINI_API_KEY = ""; 

const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${GEMINI_API_KEY}`;

const DB_NAME = "MeetingMindDB";
const DB_VERSION = 1;

const STORES = {
    MEETINGS: "meetings",         // Meeting (metadata)
    AUDIO_FILES: "audioFiles",   // AudioFile (blob + metadata)
    TRANSCRIPTS: "transcripts", // Transcript (texto)
    SUMMARIES: "summaries",       // Summary (JSON de IA)
    ACTION_ITEMS: "actionItems"  // ActionItem (extraído de IA)
};

// ----------------------------------
// ESTADO DE LA APLICACIÓN
// ----------------------------------
let db;
let currentUserId = 'mock-user-123'; // Simulación de autenticación
let mediaRecorder;
let audioChunks = [];
let recordingStartTime;
let timerInterval;
let audioContext;
let analyser;
let dataArray;
let animationFrameId;
let deferredInstallPrompt = null;
let currentMeetingBlob = null;
let currentMeetingDuration = 0;

// API de Reconocimiento de Voz
let recognition;
let finalTranscript = '';
let isSpeechRecognitionActive = false;
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SpeechRecognition) {
    recognition = new SpeechRecognition();
    recognition.continuous = true; // Sigue escuchando
    recognition.interimResults = true; // Muestra resultados intermedios
    recognition.lang = 'es-ES'; // Configurar idioma
}

// ----------------------------------
// INICIALIZACIÓN DE PWA
// ----------------------------------

/**
 * Registra el Service Worker desde el archivo externo sw.js.
 */
function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./sw.js')
            .then(registration => {
                console.log('Service Worker registrado con éxito:', registration);
            })
            .catch(error => {
                console.error('Error al registrar el Service Worker:', error);
            });
    }
}

/**
 * Configura el listener para el evento 'beforeinstallprompt'.
 */
function setupInstallPrompt(e) {
    // Prevenir que el mini-infobar aparezca
    e.preventDefault();
    // Guardar el evento para poder dispararlo después
    deferredInstallPrompt = e;
    // Mostrar nuestro botón de instalación personalizado
    const installButton = document.getElementById('install-pwa-button');
    if (installButton) {
        installButton.classList.remove('hidden');
        console.log('PWA está lista para ser instalada.');
    }
}

// ----------------------------------
// BASE DE DATOS (IndexedDB)
// ----------------------------------

/**
 * Inicializa la base de datos IndexedDB.
 * @returns {Promise<IDBDatabase>}
 */
function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (event) => {
            const db = event.target.result;

            if (!db.objectStoreNames.contains(STORES.MEETINGS)) {
                const meetingsStore = db.createObjectStore(STORES.MEETINGS, { keyPath: 'id', autoIncrement: true });
                meetingsStore.createIndex('userIdIndex', 'userId', { unique: false });
                meetingsStore.createIndex('dateIndex', 'startAt', { unique: false });
            }
            
            if (!db.objectStoreNames.contains(STORES.AUDIO_FILES)) {
                const audioStore = db.createObjectStore(STORES.AUDIO_FILES, { keyPath: 'id', autoIncrement: true });
                audioStore.createIndex('meetingIdIndex', 'meetingId', { unique: true });
            }

            if (!db.objectStoreNames.contains(STORES.TRANSCRIPTS)) {
                const transcriptStore = db.createObjectStore(STORES.TRANSCRIPTS, { keyPath: 'id', autoIncrement: true });
                transcriptStore.createIndex('meetingIdIndex', 'meetingId', { unique: true });
            }
            if (!db.objectStoreNames.contains(STORES.SUMMARIES)) {
                const summaryStore = db.createObjectStore(STORES.SUMMARIES, { keyPath: 'id', autoIncrement: true });
                summaryStore.createIndex('meetingIdIndex', 'meetingId', { unique: true });
            }

            if (!db.objectStoreNames.contains(STORES.ACTION_ITEMS)) {
                const actionItemsStore = db.createObjectStore(STORES.ACTION_ITEMS, { keyPath: 'id', autoIncrement: true });
                actionItemsStore.createIndex('meetingIdIndex', 'meetingId', { unique: false });
                actionItemsStore.createIndex('statusIndex', 'status', { unique: false });
            }
        };

        request.onsuccess = (event) => {
            db = event.target.result;
            console.log("Base de datos inicializada con éxito.");
            resolve(db);
        };

        request.onerror = (event) => {
            console.error("Error al abrir la base de datos:", event.target.errorCode);
            reject(event.target.errorCode);
        };
    });
}

/**
 * Operación genérica para añadir datos a un store.
 * @param {string} storeName - El nombre del store.
 * @param {object} data - Los datos a añadir.
 * @returns {Promise<number>} - El ID del ítem añadido.
 */
function dbAdd(storeName, data) {
    return new Promise((resolve, reject) => {
        if (!db) {
            console.error("La BD no está inicializada.");
            return reject("DB not initialized");
        }
        const transaction = db.transaction([storeName], 'readwrite');
        const store = transaction.objectStore(storeName);
        const request = store.add(data);

        request.onsuccess = (event) => {
            resolve(event.target.result); // Retorna el ID
        };

        request.onerror = (event) => {
            console.error("Error al añadir datos:", event.target.error);
            reject(event.target.error);
        };
    });
}

/**
 * Operación genérica para obtener todos los datos de un store.
 * @param {string} storeName - El nombre del store.
 * @returns {Promise<object[]>} - Un array de objetos del store.
 */
function dbGetAll(storeName) {
    return new Promise((resolve, reject) => {
        if (!db) return reject("DB not initialized");
        const transaction = db.transaction([storeName], 'readonly');
        const store = transaction.objectStore(storeName);
        const request = store.getAll();

        request.onsuccess = (event) => {
            resolve(event.target.result);
        };

        request.onerror = (event) => {
            console.error("Error al obtener todos los datos:", event.target.error);
            reject(event.target.error);
        };
    });
}

/**
 * Operación genérica para obtener un ítem por su ID.
 * @param {string} storeName - El nombre del store.
 * @param {number} id - El ID del ítem.
 * @returns {Promise<object>} - El objeto del store.
 */
function dbGet(storeName, id) {
    return new Promise((resolve, reject) => {
        if (!db) return reject("DB not initialized");
        const transaction = db.transaction([storeName], 'readonly');
        const store = transaction.objectStore(storeName);
        const request = store.get(id);

        request.onsuccess = (event) => {
            resolve(event.target.result);
        };

        request.onerror = (event) => {
            console.error("Error al obtener datos por ID:", event.target.error);
            reject(event.target.error);
        };
    });
}
/**
 * Operación genérica para actualizar un ítem.
 * @param {string} storeName - El nombre del store.
 * @param {object} data - Los datos actualizados (debe incluir el ID).
 * @returns {Promise<object>}
 */
function dbPut(storeName, data) {
    return new Promise((resolve, reject) => {
        if (!db) return reject("DB not initialized");
        const transaction = db.transaction([storeName], 'readwrite');
        const store = transaction.objectStore(storeName);
        const request = store.put(data);

        request.onsuccess = (event) => {
            resolve(event.target.result);
        };

        request.onerror = (event) => {
            console.error("Error al actualizar datos:", event.target.error);
            reject(event.target.error);
        };
    });
}

/**
 * Operación para obtener un ítem por un índice.
 * @param {string} storeName - El nombre del store.
 * @param {string} indexName - El nombre del índice.
 * @param {any} value - El valor a buscar en el índice.
 * @returns {Promise<object>} - El objeto encontrado.
 */
function dbGetByIndex(storeName, indexName, value) {
    return new Promise((resolve, reject) => {
        if (!db) return reject("DB not initialized");
        const transaction = db.transaction([storeName], 'readonly');
        const store = transaction.objectStore(storeName);
        const index = store.index(indexName);
        const request = index.get(value);

        request.onsuccess = (event) => {
            resolve(event.target.result);
        };

        request.onerror = (event) => {
            console.error("Error al obtener por índice:", event.target.error);
            reject(event.target.error);
        };
    });
}

/**
 * Operación para obtener TODOS los ítems por un índice.
 * @param {string} storeName - El nombre del store.
 * @param {string} indexName - El nombre del índice.
 * @param {any} value - El valor a buscar en el índice.
 * @returns {Promise<object[]>} - Un array de objetos.
 */
function dbGetAllByIndex(storeName, indexName, value) {
    return new Promise((resolve, reject) => {
        if (!db) return reject("DB not initialized");
        const transaction = db.transaction([storeName], 'readonly');
        const store = transaction.objectStore(storeName);
        const index = store.index(indexName);
        const request = index.getAll(value);

        request.onsuccess = (event) => {
            resolve(event.target.result);
        };

        request.onerror = (event) => {
            console.error("Error al obtener todo por índice:", event.target.error);
            reject(event.target.error);
        };
    });
}


// ----------------------------------
// LÓGICA DE NAVEGACIÓN
// ----------------------------------

/**
 * Cambia la página visible.
 * @param {string} pageId - El ID de la página a mostrar (ej: 'page-record').
 */
function navigateTo(pageId) {
    // Ocultar todas las páginas
    document.querySelectorAll('.page-content').forEach(page => {
        if (page.id !== 'page-detail') { // El detalle se maneja diferente
            page.classList.add('hidden');
        }
    });

    // Mostrar la página solicitada
    const targetPage = document.getElementById(pageId);
    if (targetPage) {
        targetPage.classList.remove('hidden');
    }

    // Actualizar estado activo de la barra de navegación
    document.querySelectorAll('.nav-button').forEach(button => {
        button.classList.remove('active');
        if (button.dataset.page === pageId) {
            button.classList.add('active');
        }
    });

    // Cargar datos si es necesario
    if (pageId === 'page-history') {
        renderHistoryList();
    }
    if (pageId === 'page-dashboard') {
        renderDashboard();
    }
}
/**
 * Muestra el modal de alerta genérico.
 * @param {string} title - Título del modal.
 * @param {string} message - Mensaje del modal.
 */
function showAlert(title, message) {
    document.getElementById('alert-title').textContent = title;
    document.getElementById('alert-message').textContent = message;
    
    const modal = document.getElementById('alert-modal');
    modal.classList.remove('hidden');
    
    // Enfocar el botón OK para accesibilidad y enter
    document.getElementById('alert-ok-button').focus();
}

/**
 * Cierra el modal de alerta genérico.
 */
function closeAlert() {
    document.getElementById('alert-modal').classList.add('hidden');
}


// ----------------------------------
// LÓGICA DE GRABACIÓN
// ----------------------------------

/**
 * Inicializa el stream de audio y el MediaRecorder.
 * @returns {Promise<MediaStream>}
 */
async function initAudio() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        
        // Configurar MediaRecorder
        const options = {
            mimeType: 'audio/webm;codecs=opus'
        };
        if (!MediaRecorder.isTypeSupported(options.mimeType)) {
            console.log("audio/webm no soportado, usando default.");
            mediaRecorder = new MediaRecorder(stream);
        } else {
            mediaRecorder = new MediaRecorder(stream, options);
        }

        // Configurar eventos de MediaRecorder
        mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0) {
                audioChunks.push(event.data);
            }
        };

        mediaRecorder.onstop = () => {
            currentMeetingBlob = new Blob(audioChunks, { type: mediaRecorder.mimeType });
            audioChunks = []; // Limpiar para la próxima grabación
            
            // Detener visualizador
            if (animationFrameId) {
                cancelAnimationFrame(animationFrameId);
            }
            if (audioContext && audioContext.state !== 'closed') {
                audioContext.close();
            }
            
            // Mostrar modal de guardar
            currentMeetingDuration = Date.now() - recordingStartTime;
            const durationInSeconds = Math.floor(currentMeetingDuration / 1000);
            document.getElementById('modal-duration-info').textContent = `Duración: ${formatTime(durationInSeconds)}`;
            document.getElementById('meeting-title-input').value = `Grabación - ${new Date().toLocaleString('es-ES')}`;
            document.getElementById('save-modal').classList.remove('hidden');
        };
        
        // Configurar Visualizador
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        analyser = audioContext.createAnalyser();
        const source = audioContext.createMediaStreamSource(stream);
        source.connect(analyser);
        
        analyser.fftSize = 256; // Tamaño de la FFT
        const bufferLength = analyser.frequencyBinCount;
        dataArray = new Uint8Array(bufferLength);
        
        return stream; // Retorna el stream para poder cerrarlo si es necesario

    } catch (err) {
        console.error('Error al acceder al micrófono:', err);
        showAlert('Error de Micrófono', 'No se pudo acceder al micrófono. Por favor, verifica los permisos del navegador.');
    }
}
/**
 * Inicia el proceso de grabación.
 */
async function startRecording() {
    // Verificar API Key de Gemini
    if (!GEMINI_API_KEY || GEMINI_API_KEY === "") {
        showAlert('Error de Configuración', 'La clave API de Gemini no está configurada en el código. No se puede procesar la IA.');
        // Nota: Permitimos grabar, pero la IA fallará.
    }
    
    // Inicializar audio (pedir permisos)
    const stream = await initAudio();
    if (!stream || !mediaRecorder) {
        // El initAudio ya mostró una alerta si falló
        return;
    }

    // Limpiar transcripción anterior
    finalTranscript = '';
    isSpeechRecognitionActive = false;

    // Iniciar MediaRecorder
    mediaRecorder.start();
    recordingStartTime = Date.now();
    
    // Iniciar cronómetro
    updateTimer(); // Actualiza a 00:00:00
    timerInterval = setInterval(updateTimer, 1000);
    
    // Iniciar visualizador
    drawVisualizer();
    
    // Iniciar Reconocimiento de Voz (si está disponible)
    if (recognition) {
        try {
            recognition.start();
            isSpeechRecognitionActive = true;
            console.log("Reconocimiento de voz iniciado.");
        } catch (e) {
            console.error("Error al iniciar reconocimiento de voz:", e);
            // Puede fallar si ya estaba corriendo, es benigno
        }
    }

    // Actualizar UI
    updateRecordingUI(true);
}

/**
 * Detiene el proceso de grabación.
 */
function stopRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop(); // Esto disparará el evento 'onstop'
    }
    
    // Detener cronómetro
    clearInterval(timerInterval);
    
    // Detener Reconocimiento de Voz
    if (recognition && isSpeechRecognitionActive) {
        recognition.stop();
        isSpeechRecognitionActive = false;
        console.log("Reconocimiento de voz detenido.");
    }
    
    // Actualizar UI
    updateRecordingUI(false);
}

/**
 * Actualiza el cronómetro en la UI.
 */
function updateTimer() {
    if (!recordingStartTime) {
        document.getElementById('timer').textContent = "00:00:00";
        return;
    }
    const seconds = Math.floor((Date.now() - recordingStartTime) / 1000);
    document.getElementById('timer').textContent = formatTime(seconds);
}

/**
 * Dibuja el visualizador de audio en el canvas.
 */
function drawVisualizer() {
    const canvas = document.getElementById('audio-visualizer');
    const canvasCtx = canvas.getContext('2d');
    const WIDTH = canvas.width;
    const HEIGHT = canvas.height;

    analyser.getByteFrequencyData(dataArray); // Obtener datos de frecuencia
    
    canvasCtx.fillStyle = '#111827'; // bg-gray-900 (limpiar)
    canvasCtx.fillRect(0, 0, WIDTH, HEIGHT);

    const barWidth = (WIDTH / dataArray.length) * 2;
    let barHeight;
    let x = 0;

    canvasCtx.fillStyle = '#06b6d4'; // text-cyan-500

    for (let i = 0; i < dataArray.length; i++) {
        barHeight = dataArray[i] / 2; // Escalar la altura
        if (barHeight < 1) barHeight = 1; // Mínimo de 1px

        canvasCtx.fillRect(x, (HEIGHT - barHeight) / 2, barWidth, barHeight);
        x += barWidth + 1; // Espacio entre barras
    }

    // Seguir dibujando si la grabación está activa
    animationFrameId = requestAnimationFrame(drawVisualizer);
}
/**
 * Actualiza la UI del botón de grabación.
 * @param {boolean} isRecording - True si está grabando.
 */
function updateRecordingUI(isRecording) {
    const recordButton = document.getElementById('record-button');
    const pulseRing = document.getElementById('pulse-ring');
    const pulseDot = document.getElementById('pulse-dot');
    const micIcon = document.getElementById('icon-mic');
    const statusText = document.getElementById('recording-status-text');

    if (isRecording) {
        statusText.textContent = "Grabando...";
        statusText.classList.add('fade-in');
        
        // Mostrar animación
        pulseRing.classList.remove('hidden');
        pulseDot.classList.remove('hidden');
        
        // Mantener el icono de mic visible, pero indicar grabación (botón ya cambia)
        recordButton.classList.add('bg-red-500', 'hover:bg-red-600');
        recordButton.classList.remove('bg-cyan-500', 'hover:bg-cyan-600');

    } else {
        statusText.textContent = "";
        statusText.classList.remove('fade-in');
        
        // Ocultar animación
        pulseRing.classList.add('hidden');
        pulseDot.classList.add('hidden');
        
        // Restaurar icono
        recordButton.classList.remove('bg-red-500', 'hover:bg-red-600');
        recordButton.classList.add('bg-cyan-500', 'hover:bg-cyan-600');
    }
}

/**
 * Guarda la reunión en la base de datos.
 */
async function saveMeeting() {
    const title = document.getElementById('meeting-title-input').value || "Grabación sin título";
    const now = Date.now();
    const startTime = recordingStartTime;
    
    // 1. Guardar metadatos de la reunión
    const meetingData = {
        userId: currentUserId,
        title: title,
        startAt: new Date(startTime).toISOString(),
        endAt: new Date(now).toISOString(),
        duration: currentMeetingDuration, // en milisegundos
        tags: [],
        participants: [],
        status: 'recorded' // Estado inicial
    };

    try {
        const meetingId = await dbAdd(STORES.MEETINGS, meetingData);
        console.log(`Reunión guardada con ID: ${meetingId}`);

        // 2. Guardar archivo de audio
        const audioData = {
            meetingId: meetingId,
            audioBlob: currentMeetingBlob, // Guardar el Blob directamente
            mimeType: currentMeetingBlob.type,
            sizeBytes: currentMeetingBlob.size
        };
        await dbAdd(STORES.AUDIO_FILES, audioData);
        console.log(`Audio guardado para Meeting ID: ${meetingId}`);

        // 3. Guardar transcripción (si la hubo)
        const transcriptData = {
            meetingId: meetingId,
            language: recognition ? recognition.lang : 'es-ES',
            text: finalTranscript || "", // Usar la transcripción final o vacío
            source: finalTranscript ? 'live' : 'none' // Indicar si fue en vivo o no
        };
        await dbAdd(STORES.TRANSCRIPTS, transcriptData);
        console.log(`Transcripción guardada para Meeting ID: ${meetingId}. Fuente: ${transcriptData.source}`);

        // 4. Limpiar y cerrar modal
        currentMeetingBlob = null;
        currentMeetingDuration = 0;
        finalTranscript = '';
        document.getElementById('save-modal').classList.add('hidden');
        
        // 5. Ir al historial para ver la nueva reunión
        navigateTo('page-history');

    } catch (error) {
        console.error("Error al guardar la reunión completa:", error);
        showAlert("Error al Guardar", "No se pudo guardar la reunión. Revisa la consola.");
    }
}
/**
 * Descarta la grabación actual.
 */
function discardRecording() {
    currentMeetingBlob = null;
    currentMeetingDuration = 0;
    finalTranscript = ''; // También descarta la transcripción
    document.getElementById('save-modal').classList.add('hidden');
    console.log("Grabación descartada.");
}


// ----------------------------------
// LÓGICA DE HISTORIAL Y DETALLE
// ----------------------------------

/**
 * Carga y renderiza la lista de reuniones en el historial.
 */
async function renderHistoryList() {
    const listContainer = document.getElementById('history-list-container');
    const emptyState = document.getElementById('history-empty-state');
    
    try {
        const meetings = await dbGetAll(STORES.MEETINGS);
        
        // Ordenar: más recientes primero
        meetings.sort((a, b) => new Date(b.startAt) - new Date(a.startAt));

        if (meetings.length === 0) {
            emptyState.classList.remove('hidden');
            // Limpiar lista por si acaso
            const existingCards = listContainer.querySelectorAll('.meeting-card');
            existingCards.forEach(card => card.remove());
            return;
        }

        emptyState.classList.add('hidden');
        
        // Limpiar lista anterior antes de re-renderizar
        const existingCards = listContainer.querySelectorAll('.meeting-card');
        existingCards.forEach(card => card.remove());

        // Crear y añadir tarjetas de reunión
        meetings.forEach(meeting => {
            const card = document.createElement('div');
            card.className = 'bg-gray-800 p-4 rounded-lg shadow mb-3 flex justify-between items-center meeting-card';
            card.dataset.meetingId = meeting.id;

            const durationSec = Math.floor(meeting.duration / 1000);
            const statusColor = getStatusColor(meeting.status);

            card.innerHTML = `
                <div>
                    <h3 class="text-lg font-semibold text-white truncate">${meeting.title}</h3>
                    <p class="text-sm text-gray-400">${new Date(meeting.startAt).toLocaleDateString('es-ES', { day: '2-digit', month: 'long', year: 'numeric' })}</p>
                    <p class="text-sm text-gray-500">Duración: ${formatTime(durationSec)}</p>
                </div>
                <div class="text-right">
                    <span class="inline-block px-2 py-1 text-xs font-semibold rounded-full ${statusColor.bg} ${statusColor.text}">
                        ${statusColor.label}
                    </span>
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 text-gray-500 mt-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
                    </svg>
                </div>
            `;
            
            // Añadir evento de clic para abrir detalles
            card.addEventListener('click', () => openDetailPage(meeting.id));
            
            listContainer.appendChild(card);
        });

    } catch (error) {
        console.error("Error al renderizar el historial:", error);
    }
}

/**
 * Abre la página de detalle para una reunión específica.
 * @param {number} meetingId - El ID de la reunión a abrir.
 */
async function openDetailPage(meetingId) {
    const detailPage = document.getElementById('page-detail');
    detailPage.dataset.currentMeetingId = meetingId; // Guardar ID actual
    
    try {
        // 1. Obtener Metadatos de la Reunión
        const meeting = await dbGet(STORES.MEETINGS, meetingId);
        if (!meeting) {
            showAlert("Error", "No se encontró la reunión.");
            return;
        }

        // 2. Obtener Archivo de Audio
        const audioRecord = await dbGetByIndex(STORES.AUDIO_FILES, 'meetingIdIndex', meetingId);
        const audioPlayer = document.getElementById('audio-player');
        if (audioRecord && audioRecord.audioBlob) {
            const audioUrl = URL.createObjectURL(audioRecord.audioBlob);
            audioPlayer.src = audioUrl;
            audioPlayer.style.display = 'block';
        } else {
            audioPlayer.style.display = 'none'; // Ocultar si no hay audio
        }
        // 3. Obtener Transcripción
        const transcriptRecord = await dbGetByIndex(STORES.TRANSCRIPTS, 'meetingIdIndex', meetingId);
        const transcriptEditor = document.getElementById('transcript-editor');
        if (transcriptRecord) {
            transcriptEditor.value = transcriptRecord.text || "";
            if (transcriptRecord.text && transcriptRecord.source === 'live') {
                // Si hay texto y fue en vivo, lo consideramos "transcrito"
                if (meeting.status === 'recorded') {
                    meeting.status = 'transcribed';
                    await dbPut(STORES.MEETINGS, meeting);
                }
            }
        } else {
            transcriptEditor.value = ""; // Limpiar si no hay record
        }

        // 4. Obtener Minuta (Resumen IA)
        const summaryRecord = await dbGetByIndex(STORES.SUMMARIES, 'meetingIdIndex', meetingId);
        const summaryContent = document.getElementById('summary-content');
        const summaryEmptyState = document.getElementById('summary-empty-state');
        if (summaryRecord) {
            summaryContent.innerHTML = formatSummaryToHTML(summaryRecord.data);
            summaryContent.classList.remove('hidden');
            summaryEmptyState.classList.add('hidden');
        } else {
            summaryContent.innerHTML = '';
            summaryContent.classList.add('hidden');
            summaryEmptyState.classList.remove('hidden');
        }

        // 5. Rellenar detalles y estado del botón IA
        const statusColor = getStatusColor(meeting.status);
        document.getElementById('detail-title').textContent = meeting.title;
        document.getElementById('detail-date').textContent = new Date(meeting.startAt).toLocaleString('es-ES');
        document.getElementById('detail-duration').textContent = formatTime(Math.floor(meeting.duration / 1000));
        document.getElementById('detail-status').textContent = statusColor.label;

        // Lógica del botón de IA
        const aiButton = document.getElementById('process-ai-button');
        const aiButtonText = document.getElementById('ai-button-text');
        
        if (meeting.status === 'summarized') {
            aiButtonText.textContent = "Minuta Generada (Completo)";
            aiButton.disabled = true;
        } else if (meeting.status === 'transcribed' || transcriptEditor.value.trim().length > 0) {
            aiButtonText.textContent = "Generar Resumen (IA)";
            aiButton.disabled = false;
        } else {
            aiButtonText.textContent = "Transcripción Vacía";
            aiButton.disabled = true; // Deshabilitado si no hay texto
        }
        
        // 6. Mostrar la página y resetear pestañas
        navigateToTab('tab-summary');
        detailPage.classList.remove('translate-x-full');

    } catch (error) {
        console.error("Error al abrir detalle:", error);
        showAlert("Error", "No se pudo cargar el detalle de la reunión.");
    }
}

/**
 * Cierra la página de detalle y vuelve al historial.
 */
function closeDetailPage() {
    const detailPage = document.getElementById('page-detail');
    detailPage.classList.add('translate-x-full');
    
    // Detener reproductor de audio
    const audioPlayer = document.getElementById('audio-player');
    if (audioPlayer) {
        audioPlayer.pause();
        audioPlayer.src = ''; // Liberar el Object URL
    }
    
    // Limpiar el ID
    detailPage.dataset.currentMeetingId = '';
    
    // Refrescar la lista del historial
    renderHistoryList();
}

/**
 * Cambia la pestaña visible dentro de la página de detalle.
 * @param {string} tabId - El ID de la pestaña a mostrar (ej: 'tab-summary').
 */
function navigateToTab(tabId) {
    // Ocultar todos los contenidos de pestaña
    document.querySelectorAll('.tab-content').forEach(tab => {
        tab.classList.add('hidden');
    });
    
    // Quitar estado activo de botones de pestaña
    document.querySelectorAll('.tab-button').forEach(button => {
        button.classList.remove('active');
    });

    // Mostrar el contenido y botón activos
    document.getElementById(tabId).classList.remove('hidden');
    const activeButton = document.querySelector(`.tab-button[data-tab="${tabId}"]`);
    if (activeButton) {
        activeButton.classList.add('active');
    }
}
/**
 * Guarda el texto editado en la transcripción.
 */
async function saveTranscript() {
    const meetingId = parseInt(document.getElementById('page-detail').dataset.currentMeetingId, 10);
    const newText = document.getElementById('transcript-editor').value;

    try {
        const transcriptRecord = await dbGetByIndex(STORES.TRANSCRIPTS, 'meetingIdIndex', meetingId);
        
        if (transcriptRecord) {
            transcriptRecord.text = newText;
            transcriptRecord.source = 'manual'; // Marcar como editado manualmente
            await dbPut(STORES.TRANSCRIPTS, transcriptRecord);
        } else {
            // Si no existía, crear uno nuevo
            await dbAdd(STORES.TRANSCRIPTS, {
                meetingId: meetingId,
                language: 'es-ES',
                text: newText,
                source: 'manual'
            });
        }
        
        // Actualizar estado de la reunión
        const meeting = await dbGet(STORES.MEETINGS, meetingId);
        if (meeting.status === 'recorded' && newText.trim().length > 0) {
            meeting.status = 'transcribed';
            await dbPut(STORES.MEETINGS, meeting);
        }
        
        // Volver a cargar la página de detalle para reflejar cambios
        await openDetailPage(meetingId);
        
        showAlert("Éxito", "Transcripción guardada correctamente.");

    } catch (error) {
        console.error("Error al guardar transcripción:", error);
        showAlert("Error", "No se pudo guardar la transcripción.");
    }
}


// ----------------------------------
// LÓGICA DE IA (GEMINI)
// ----------------------------------

/**
 * Inicia el proceso de IA (transcripción + resumen).
 */
async function processMeetingWithAI() {
    const meetingId = parseInt(document.getElementById('page-detail').dataset.currentMeetingId, 10);
    
    // Verificar API Key
    if (!GEMINI_API_KEY || GEMINI_API_KEY === "") {
        showAlert('Error de Configuración', 'La clave API de Gemini no está configurada en el código. No se puede procesar la IA.');
        return;
    }

    // Mostrar spinner en el botón
    const aiButton = document.getElementById('process-ai-button');
    const aiButtonText = document.getElementById('ai-button-text');
    const aiButtonSpinner = document.getElementById('ai-button-spinner');
    
    aiButton.disabled = true;
    aiButtonText.textContent = "Procesando con IA...";
    aiButtonSpinner.classList.remove('hidden');

    try {
        // 1. Obtener la transcripción de la BD
        const transcriptRecord = await dbGetByIndex(STORES.TRANSCRIPTS, 'meetingIdIndex', meetingId);
        
        if (!transcriptRecord || !transcriptRecord.text || transcriptRecord.text.trim().length === 0) {
            showAlert("Error de IA", "No hay transcripción disponible para resumir. Por favor, edítala manualmente primero.");
            throw new Error("Transcripción vacía");
        }
        
        const transcriptText = transcriptRecord.text;
        
        // 2. Obtener metadatos de la reunión para el prompt
        const meeting = await dbGet(STORES.MEETINGS, meetingId);
        
        // 3. Llamar a Gemini
        const summaryData = await getGeminiSummary(transcriptText, meeting);
        
        // 4. Guardar los resultados en la BD
        
        // 4a. Guardar el Resumen/Minuta
        const summaryRecord = {
            meetingId: meetingId,
            data: summaryData // Guardar el JSON completo
        };
        await dbAdd(STORES.SUMMARIES, summaryRecord);
        console.log("Minuta de IA guardada.");

        // 4b. Guardar las Tareas (Action Items)
        if (summaryData.plan_de_accion && summaryData.plan_de_accion.length > 0) {
            for (const item of summaryData.plan_de_accion) {
                const actionItem = {
                    meetingId: meetingId,
                    title: item.tarea || "Tarea sin título",
                    assignee: item.responsable || "Por definir",
                    dueDate: item.fecha_limite || null,
                    priority: item.prioridad || "Media",
                    status: item.estado || "Pendiente"
                };
                await dbAdd(STORES.ACTION_ITEMS, actionItem);
            }
            console.log(`${summaryData.plan_de_accion.length} tareas guardadas.`);
        }
        
        // 5. Actualizar estado de la reunión
        meeting.status = 'summarized';
        await dbPut(STORES.MEETINGS, meeting);
        
        // 6. Recargar la página de detalle para mostrar la minuta
        await openDetailPage(meetingId);
        
        // Ocultar spinner
        aiButtonText.textContent = "Minuta Generada (Completo)";
        aiButtonSpinner.classList.add('hidden');
        // aiButton.disabled = true; // Ya se deshabilita en openDetailPage

    } catch (error) {
        console.error("Error en el proceso de IA:", error);
        showAlert("Error de IA", `No se pudo completar el proceso: ${error.message}`);
        
        // Restaurar botón en caso de error
        aiButton.disabled = false;
        aiButtonText.textContent = "Generar Resumen (IA)";
        aiButtonSpinner.classList.add('hidden');
    }
}
/**
 * Llama a la API de Gemini para obtener el resumen estructurado.
 * @param {string} transcriptText - El texto de la transcripción.
 * @param {object} meeting - El objeto de la reunión.
 * @returns {Promise<object>} - El JSON con la minuta.
 */
async function getGeminiSummary(transcriptText, meeting) {
    console.log("Llamando a la API de Gemini...");

    // Definir el Schema para la respuesta JSON
    const schema = {
        type: "OBJECT",
        properties: {
            "titulo": { "type": "STRING", "description": "Título conciso de la reunión basado en el contenido." },
            "fecha": { "type": "STRING", "description": "Fecha de la reunión en formato AAAA-MM-DD." },
            "hora": { "type": "STRING", "description": "Rango de hora (HH:MM - HH:MM)." },
            "resumen_general": { "type": "STRING", "description": "Resumen ejecutivo de 150-250 palabras." },
            "objetivo_general": { "type": "STRING", "description": "El propósito principal de la reunión." },
            "desarrollo_por_participante": {
                "type": "ARRAY",
                "items": {
                    "type": "OBJECT",
                    "properties": {
                        "nombre": { "type": "STRING", "description": "Nombre del participante (o 'Varios' si no está claro)." },
                        "aportes": { "type": "STRING", "description": "Resumen de sus aportes clave." }
                    },
                    "required": ["nombre", "aportes"]
                }
            },
            "puntos_relevantes": {
                "type": "ARRAY",
                "items": { "type": "STRING" },
                "description": "Lista de 3-5 puntos clave discutidos."
            },
            "plan_de_accion": {
                "type": "ARRAY",
                "items": {
                    "type": "OBJECT",
                    "properties": {
                        "tarea": { "type": "STRING" },
                        "responsable": { "type": "STRING" },
                        "fecha_limite": { "type": "STRING", "description": "Formato AAAA-MM-DD o 'Por definir'." },
                        "prioridad": { "type": "STRING", "description": "Alta, Media, o Baja." },
                        "estado": { "type": "STRING", "description": "Pendiente, En curso, o Hecha." }
                    },
                    "required": ["tarea", "responsable", "fecha_limite", "prioridad", "estado"]
                }
            },
            "temas": {
                "type": "ARRAY",
                "items": { "type": "STRING" },
                "description": "Lista de 5-10 temas o keywords para etiquetado."
            }
        },
        required: ["titulo", "fecha", "hora", "resumen_general", "objetivo_general", "desarrollo_por_participante", "puntos_relevantes", "plan_de_accion", "temas"]
    };

    const systemPrompt = `Eres un asistente experto que sintetiza reuniones en español a partir de una transcripción.
Tu objetivo es devolver SIEMPRE un único objeto JSON válido que se adhiera estrictamente al schema proporcionado.
La fecha de la reunión es: ${new Date(meeting.startAt).toISOString().split('T')[0]}.
La hora de inicio fue ${new Date(meeting.startAt).toTimeString().substr(0,5)} y la de fin ${new Date(meeting.endAt).toTimeString().substr(0,5)}.
Usa esa información para los campos 'fecha' y 'hora'.
Considera el idioma detectado, corrige errores de transcripción y conserva cifras/fechas/textos literales críticos.
Si hay ambigüedades en la transcripción sobre un punto, marca ese punto con "TODO: verificar".
La transcripción es:
${transcriptText}`;

    const payload = {
        contents: [
            { parts: [{ text: systemPrompt }] }
        ],
        generationConfig: {
            responseMimeType: "application/json",
            responseSchema: schema
        }
    };

    const response = await fetch(GEMINI_API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        const errorBody = await response.text();
        console.error("Error en la API de Gemini:", response.status, errorBody);
        throw new Error(`Error ${response.status} de la API de Gemini.`);
    }

    const result = await response.json();
    
    // Extraer el texto JSON de la respuesta
    try {
        const jsonText = result.candidates[0].content.parts[0].text;
        return JSON.parse(jsonText);
    } catch (e) {
        console.error("Error al parsear la respuesta JSON de Gemini:", e, result);
        throw new Error("La respuesta de la IA no fue un JSON válido.");
    }
}


// ----------------------------------
// LÓGICA DEL DASHBOARD
// ----------------------------------

/**
 * Carga y renderiza los datos del Dashboard.
 */
async function renderDashboard() {
    try {
        const allMeetings = await dbGetAll(STORES.MEETINGS);
        const allActionItems = await dbGetAll(STORES.ACTION_ITEMS);
        const allSummaries = await dbGetAll(STORES.SUMMARIES);
        
        // Filtrar por el último mes (simple)
        const oneMonthAgo = new Date();
        oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
        
        const meetingsThisMonth = allMeetings.filter(m => new Date(m.startAt) >= oneMonthAgo);

        // KPI 1: Tiempo Total
        const totalMs = meetingsThisMonth.reduce((acc, m) => acc + m.duration, 0);
        const totalMinutes = Math.floor(totalMs / 60000);
        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;
        document.getElementById('kpi-total-time').textContent = `${hours}h ${minutes}m`;

        // KPI 2: Reuniones Totales
        document.getElementById('kpi-total-meetings').textContent = meetingsThisMonth.length;
        
        // KPI 3: Tareas Abiertas
        const openTasks = allActionItems.filter(t => t.status !== 'Hecha');
        document.getElementById('kpi-open-tasks').textContent = openTasks.length;
        
        // KPI 4: % Con Plan de Acción
        const meetingsWithSummaries = allSummaries.length;
        const meetingsWithActions = allSummaries.filter(s => s.data.plan_de_accion && s.data.plan_de_accion.length > 0).length;
        const pct = (meetingsWithSummaries === 0) ? 0 : Math.round((meetingsWithActions / meetingsWithSummaries) * 100);
        document.getElementById('kpi-action-items-pct').textContent = `${pct}%`;

        // Renderizar lista de Tareas Abiertas
        renderOpenTasks(openTasks);

    } catch (error) {
        console.error("Error al renderizar el dashboard:", error);
    }
}

/**
 * Renderiza la lista de tareas abiertas en el Dashboard.
 * @param {object[]} openTasks - Array de tareas con estado != 'Hecha'.
 */
function renderOpenTasks(openTasks) {
    const tasksList = document.getElementById('tasks-list');
    const tasksEmptyState = document.getElementById('tasks-empty-state');
    
    // Ordenar: más urgentes (fecha límite más cercana) primero
    openTasks.sort((a, b) => {
        if (!a.dueDate) return 1;
        if (!b.dueDate) return -1;
        return new Date(a.dueDate) - new Date(b.dueDate);
    });
    
    // Limitar a 10
    const tasksToShow = openTasks.slice(0, 10);
    
    if (tasksToShow.length === 0) {
        tasksEmptyState.classList.remove('hidden');
        tasksList.innerHTML = '';
        return;
    }
    
    tasksEmptyState.classList.add('hidden');
    tasksList.innerHTML = tasksToShow.map(task => {
        const dueDate = task.dueDate ? new Date(task.dueDate).toLocaleDateString('es-ES') : 'Sin fecha';
        
        let priorityColor = 'text-yellow-400'; // Media (default)
        if (task.priority === 'Alta') priorityColor = 'text-red-400';
        if (task.priority === 'Baja') priorityColor = 'text-green-400';

        return `
            <li class="bg-gray-800 p-3 rounded-lg flex items-center justify-between">
                <div>
                    <p class="text-white">${task.title}</p>
                    <p class="text-sm text-gray-400">
                        <span class="${priorityColor}">● ${task.priority}</span> | Vence: ${dueDate}
                    </p>
                </div>
                <span class="text-sm text-gray-500">${task.assignee}</span>
            </li>
        `;
    }).join('');
}


// ----------------------------------
// FUNCIONES AUXILIARES (Helpers)
// ----------------------------------

/**
 * Formatea segundos a un string "HH:MM:SS" o "MM:SS".
 * @param {number} totalSeconds - El total de segundos.
 * @returns {string} - El tiempo formateado.
 */
function formatTime(totalSeconds) {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    const pad = (num) => num.toString().padStart(2, '0');

    if (hours > 0) {
        return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
    } else {
        return `${pad(minutes)}:${pad(seconds)}`;
    }
}

/**
 * Retorna clases de color y etiqueta para un estado de reunión.
 * @param {string} status - El estado (recorded, transcribed, summarized).
 * @returns {object} { label, bg, text }
 */
function getStatusColor(status) {
    switch (status) {
        case 'summarized':
            return { label: 'Minuta OK', bg: 'bg-green-200', text: 'text-green-900' };
        case 'transcribed':
            return { label: 'Transcrito', bg: 'bg-blue-200', text: 'text-blue-900' };
        case 'recorded':
        default:
            return { label: 'Grabado', bg: 'bg-yellow-200', text: 'text-yellow-900' };
    }
}

/**
 * Convierte el JSON de la minuta de IA en HTML legible.
 * @param {object} data - El objeto JSON de la minuta.
 * @returns {string} - HTML.
 */
function formatSummaryToHTML(data) {
    if (!data) return "<p>Error: Datos de minuta no encontrados.</p>";
    
    let html = '';

    if (data.resumen_general) {
        html += `<div class="mb-4"><h3 class="text-lg font-semibold text-cyan-400 mb-2">Resumen General</h3><p class="text-gray-300 bg-gray-800 p-3 rounded-lg">${data.resumen_general}</p></div>`;
    }
    if (data.objetivo_general) {
        html += `<div class="mb-4"><h3 class="text-lg font-semibold text-cyan-400 mb-2">Objetivo General</h3><p class="text-gray-300 bg-gray-800 p-3 rounded-lg">${data.objetivo_general}</p></div>`;
    }
    
    if (data.puntos_relevantes && data.puntos_relevantes.length > 0) {
        html += `<div class="mb-4"><h3 class="text-lg font-semibold text-cyan-400 mb-2">Puntos Relevantes</h3><ul class="list-disc list-inside bg-gray-800 p-3 rounded-lg text-gray-300 space-y-1">`;
        data.puntos_relevantes.forEach(point => {
            html += `<li>${point}</li>`;
        });
        html += `</ul></div>`;
    }
    
    if (data.desarrollo_por_participante && data.desarrollo_por_participante.length > 0) {
        html += `<div class="mb-4"><h3 class="text-lg font-semibold text-cyan-400 mb-2">Desarrollo por Participante</h3><div class="space-y-2">`;
        data.desarrollo_por_participante.forEach(p => {
            html += `<div class="bg-gray-800 p-3 rounded-lg"><strong class="text-white">${p.nombre}:</strong><p class="text-gray-300">${p.aportes}</p></div>`;
        });
        html += `</div></div>`;
    }

    if (data.plan_de_accion && data.plan_de_accion.length > 0) {
        html += `<div class="mb-4"><h3 class="text-lg font-semibold text-cyan-400 mb-2">Plan de Acción</h3><div class="overflow-x-auto"><table class="w-full min-w-max bg-gray-800 rounded-lg"><thead><tr class="bg-gray-700">`;
        html += `<th class="p-2 text-left text-sm font-semibold text-gray-300">Tarea</th><th class="p-2 text-left text-sm font-semibold text-gray-300">Responsable</th><th class="p-2 text-left text-sm font-semibold text-gray-300">Fecha Límite</th>`;
        html += `</tr></thead><tbody class="text-gray-300">`;
        data.plan_de_accion.forEach(task => {
            html += `<tr class="border-t border-gray-700"><td class="p-2">${task.tarea}</td><td class="p-2">${task.responsable}</td><td class="p-2">${task.fecha_limite}</td></tr>`;
        });
        html += `</tbody></table></div></div>`;
    }
    
    if (data.temas && data.temas.length > 0) {
        html += `<div class="mb-4"><h3 class="text-lg font-semibold text-cyan-400 mb-2">Temas Clave</h3><div class="flex flex-wrap gap-2 bg-gray-800 p-3 rounded-lg">`;
        data.temas.forEach(topic => {
            html += `<span class="px-2 py-1 bg-gray-700 text-cyan-300 rounded-full text-sm">${topic}</span>`;
        });
        html += `</div></div>`;
    }

    return html;
}


// ----------------------------------
// EVENT LISTENERS (Inicialización)
// ----------------------------------

/**
 * Inicializa la aplicación completa.
 */
async function initApp() {
    // 1. Inicializar la Base de Datos primero
    try {
        await initDB();
    } catch (error) {
        console.error("Fallo crítico: No se pudo iniciar la BD.", error);
        showAlert("Error Crítico", "No se pudo iniciar la base de datos local. La aplicación no puede funcionar.");
        return;
    }

    // 2. Configurar Listeners de PWA
    registerServiceWorker();
    window.addEventListener('beforeinstallprompt', setupInstallPrompt);

    // 3. Configurar Navegación Principal
    document.querySelectorAll('.nav-button').forEach(button => {
        button.addEventListener('click', () => {
            navigateTo(button.dataset.page);
        });
    });

    // 4. Configurar Página de Grabación
    const recordButton = document.getElementById('record-button');
    const consentCheckbox = document.getElementById('consent-checkbox');
    
    consentCheckbox.addEventListener('change', () => {
        recordButton.disabled = !consentCheckbox.checked;
    });
    
    recordButton.addEventListener('click', () => {
        if (mediaRecorder && mediaRecorder.state === 'recording') {
            stopRecording();
        } else {
            startRecording();
        }
    });

    // 5. Configurar Modal de Guardar
    document.getElementById('save-button').addEventListener('click', saveMeeting);
    document.getElementById('discard-button').addEventListener('click', discardRecording);

    // 6. Configurar Modal de Alerta
    document.getElementById('alert-ok-button').addEventListener('click', closeAlert);

    // 7. Configurar Página de Detalle
    document.getElementById('back-to-history').addEventListener('click', closeDetailPage);
    
    document.querySelectorAll('.tab-button').forEach(button => {
        button.addEventListener('click', () => {
            navigateToTab(button.dataset.tab);
        });
    });
    
    document.getElementById('process-ai-button').addEventListener('click', processMeetingWithAI);
    document.getElementById('save-transcript-button').addEventListener('click', saveTranscript);

    // 8. Configurar Botón de Instalar PWA
    const installButton = document.getElementById('install-pwa-button');
    installButton.addEventListener('click', async () => {
        if (!deferredInstallPrompt) {
            return;
        }
        // Mostrar el prompt de instalación
        deferredInstallPrompt.prompt();
        // Esperar la elección del usuario
        const { outcome } = await deferredInstallPrompt.userChoice;
        if (outcome === 'accepted') {
            console.log('El usuario aceptó la instalación');
        } else {
            console.log('El usuario rechazó la instalación');
        }
        // Solo se puede usar una vez
        deferredInstallPrompt = null;
        // Ocultar el botón
        installButton.classList.add('hidden');
    });
    
    // 9. Configurar Reconocimiento de Voz (si existe)
    if (recognition) {
        recognition.onresult = (event) => {
            let tempInterim = '';
            for (let i = event.resultIndex; i < event.results.length; ++i) {
                if (event.results[i].isFinal) {
                    finalTranscript += event.results[i][0].transcript + ' ';
                } else {
                    tempInterim += event.results[i][0].transcript;
                }
            }
            interimTranscript = tempInterim;
            
            // Oculto: No actualizamos la UI de transcripción en vivo
            // document.getElementById('live-transcript-display').textContent = finalTranscript + interimTranscript;
        };
        
        recognition.onend = () => {
            // Reiniciar automáticamente si la grabación sigue activa
            if (mediaRecorder && mediaRecorder.state === 'recording' && isSpeechRecognitionActive) {
                try {
                    recognition.start();
                } catch(e) {
                    console.error("Error al reiniciar recognition:", e);
                }
            }
        };
        
        recognition.onerror = (event) => {
            console.error("Error en reconocimiento de voz:", event.error);
            if (event.error === 'no-speech' || event.error === 'audio-capture') {
                // Errores comunes, no críticos
            }
        };
    }

    // 10. Cargar página inicial (grabación)
    navigateTo('page-record');
    console.log("Aplicación MeetingMind inicializada.");
}

// ----------------------------------
// INICIO DE LA APLICACIÓN
// ----------------------------------
document.addEventListener('DOMContentLoaded', initApp);
