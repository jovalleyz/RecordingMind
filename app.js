// ¡IMPORTANTE! Reemplaza esto con tu propia clave de API de Gemini
const GEMINI_API_KEY = "AIzaSyCiqpmd1hHjQxkWVlR4VY6zzlycHjBRLkM";

// Configuración de la Base de Datos
const DB_NAME = 'MeetingMindDB';
const DB_VERSION = 1;
const STORES = {
    MEETINGS: 'meetings',       // Almacena metadatos y el BLOB de audio
    TRANSCRIPTS: 'transcripts', // Almacena el texto de la transcripción
    SUMMARIES: 'summaries',     // Almacena el JSON de la IA
    ACTION_ITEMS: 'actionItems' // Almacena tareas extraídas
};

let db; // Variable para la instancia de la DB

// Variables de estado de grabación
let mediaRecorder;
let audioChunks = [];
let recordingStartTime;
let timerInterval;

// Variables de estado de transcripción en vivo
let recognition;
let finalTranscript = '';
let interimTranscript = '';
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (!SpeechRecognition) {
    console.warn('SpeechRecognition no es soportado por este navegador. Se deberá transcribir manualmente.');
}

// Variables de estado de la PWA
let deferredInstallPrompt;

// --- INICIALIZACIÓN DE LA APP ---

// Evento principal que se dispara cuando el HTML está cargado
document.addEventListener('DOMContentLoaded', initApp);

/**
 * Función principal de inicialización
 */
async function initApp() {
    console.log('Iniciando MeetingMind v2...');
    try {
        await initDB();
        registerServiceWorker();
        initEventListeners();
        initNavigation();
        initPWAInstall();
        renderHistoryList(); // Cargar historial al inicio
        renderDashboard();   // Cargar dashboard al inicio
    } catch (error) {
        console.error("Error al inicializar la aplicación:", error);
    }
}

/**
 * Registra el Service Worker para la PWA
 */
function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./sw.js')
            .then(registration => console.log('Service Worker registrado con éxito:', registration))
            .catch(error => console.error('Error al registrar el Service Worker:', error));
    }
}

/**
 * Inicializa los listeners para la instalación de la PWA
 */
function initPWAInstall() {
    const installButtonContainer = document.getElementById('install-pwa-container');
    const installButton = document.getElementById('install-pwa-button');

    window.addEventListener('beforeinstallprompt', (event) => {
        // Prevenir que el mini-infobar aparezca en Chrome
        event.preventDefault();
        // Guardar el evento para dispararlo luego
        deferredInstallPrompt = event;
        // Mostrar nuestro botón de instalación
        installButtonContainer.classList.remove('hidden');
    });

    installButton.addEventListener('click', async () => {
        if (deferredInstallPrompt) {
            // Mostrar el prompt de instalación
            deferredInstallPrompt.prompt();
            // Esperar la decisión del usuario
            const { outcome } = await deferredInstallPrompt.userChoice;
            console.log(`Resultado de la instalación: ${outcome}`);
            // Limpiar el evento
            deferredInstallPrompt = null;
            // Ocultar el botón
            installButtonContainer.classList.add('hidden');
        }
    });
}


// --- LÓGICA DE NAVEGACIÓN ---

/**
 * Configura los botones de la barra de navegación inferior
 */
function initNavigation() {
    const navButtons = document.querySelectorAll('.nav-button');
    navButtons.forEach(button => {
        button.addEventListener('click', () => {
            const pageName = button.dataset.page;
            
            // Ocultar todas las páginas y botones
            document.querySelectorAll('[data-page]').forEach(page => page.classList.remove('active'));
            navButtons.forEach(btn => btn.classList.remove('active'));

            // Mostrar la página y el botón seleccionados
            document.getElementById(`page-${pageName}`).classList.add('active');
            button.classList.add('active');

            // Acciones específicas por página
            if (pageName === 'history') {
                renderHistoryList();
            } else if (pageName === 'dashboard') {
                renderDashboard();
            }
        });
    });
}

/**
 * Configura las pestañas dentro del modal de detalle
 */
function initModalTabs() {
    const modalTabButtons = document.querySelectorAll('.modal-tab-button');
    const modalTabContents = document.querySelectorAll('.modal-tab-content');

    modalTabButtons.forEach(button => {
        button.addEventListener('click', () => {
            const tabName = button.dataset.tab;

            // Desactivar todos
            modalTabButtons.forEach(btn => btn.classList.remove('active'));
            modalTabContents.forEach(content => content.classList.remove('active'));

            // Activar el seleccionado
            button.classList.add('active');
            document.getElementById(`modal-tab-${tabName}`).classList.add('active');
        });
    });
}


// --- MANEJO DE EVENTOS (LISTENERS) ---

/**
 * Agrupa todos los listeners de eventos de la UI
 */
function initEventListeners() {
    // Pestaña Grabar
    document.getElementById('consent-checkbox').addEventListener('change', toggleRecordButton);
    document.getElementById('record-button').addEventListener('click', handleRecordButtonClick);

    // Modal de Detalle
    document.getElementById('modal-close-button').addEventListener('click', closeMeetingDetailModal);
    document.getElementById('modal-backdrop').addEventListener('click', closeMeetingDetailModal);
    document.getElementById('generate-ai-summary-button').addEventListener('click', processMeetingWithAI);
    document.getElementById('modal-save-metadata-button').addEventListener('click', saveModalMetadata);
    document.getElementById('modal-delete-button').addEventListener('click', handleDeleteMeetingClick);
    document.getElementById('save-transcript-button').addEventListener('click', saveTranscriptChanges);
    document.getElementById('modal-export-json-button').addEventListener('click', exportMeetingAsJSON);

    // Pestaña Historial
    document.getElementById('search-history').addEventListener('input', renderHistoryList);

    // Pestaña Perfil
    document.getElementById('export-all-data').addEventListener('click', exportAllData);
    document.getElementById('delete-all-data').addEventListener('click', handleDeleteAllDataClick);
    
    // Alertas
    document.getElementById('alert-modal-cancel').addEventListener('click', closeAlertModal);

    // Inicializar pestañas del modal
    initModalTabs();
}


// --- LÓGICA DE GRABACIÓN ---

/**
 * Activa/Desactiva el botón de grabar basado en el consentimiento
 */
function toggleRecordButton() {
    const checkbox = document.getElementById('consent-checkbox');
    const recordButton = document.getElementById('record-button');
    recordButton.disabled = !checkbox.checked;
}

/**
 * Maneja el clic en el botón principal de grabación (iniciar/detener)
 */
function handleRecordButtonClick() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
        stopRecording();
    } else {
        startRecording();
    }
}

/**
 * Inicia la grabación de audio y la transcripción en vivo
 */
async function startRecording() {
    // Solicitar permiso de micrófono
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        
        mediaRecorder = new MediaRecorder(stream);
        audioChunks = [];
        recordingStartTime = new Date();

        mediaRecorder.ondataavailable = event => {
            audioChunks.push(event.data);
        };

        mediaRecorder.onstop = saveRecording;

        mediaRecorder.start();
        startTimer();
        updateRecordingUI(true);

        // Iniciar transcripción en vivo si es soportada
        startLiveTranscription();

    } catch (error) {
        console.error('Error al iniciar la grabación:', error);
        showAlertModal("Error de Micrófono", "No se pudo acceder al micrófono. Por favor, verifica los permisos en tu navegador.");
    }
}

/**
 * Detiene la grabación de audio y la transcripción
 */
function stopRecording() {
    if (mediaRecorder) {
        mediaRecorder.stop();
        stopTimer();
        updateRecordingUI(false);
        stopLiveTranscription();
    }
}

/**
 * Guarda la grabación en IndexedDB
 */
async function saveRecording() {
    const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
    const recordingEndTime = new Date();
    const duration = recordingEndTime.getTime() - recordingStartTime.getTime();

    const newMeeting = {
        id: `meeting_${Date.now()}`,
        title: `Grabación - ${recordingStartTime.toLocaleString()}`,
        startAt: recordingStartTime.toISOString(),
        endAt: recordingEndTime.toISOString(),
        duration: duration,
        tags: [],
        audioBlob: audioBlob,
        transcript: finalTranscript, // Guardar la transcripción en vivo
        aiStatus: 'pending' // 'pending', 'processing', 'done'
    };

    try {
        await dbAdd(STORES.MEETINGS, newMeeting);
        console.log('Reunión guardada:', newMeeting.id);
        // Opcional: mostrar un mensaje de éxito
    } catch (error) {
        console.error('Error al guardar la reunión:', error);
    }

    // Limpiar para la próxima grabación
    audioChunks = [];
    finalTranscript = '';
    interimTranscript = '';
}


// --- LÓGICA DE TRANSCRIPCIÓN EN VIVO (SpeechRecognition) ---

/**
 * Inicia la API de SpeechRecognition
 */
function startLiveTranscription() {
    if (!SpeechRecognition) {
        document.getElementById('recording-status').textContent = 'Transcripción en vivo no soportada.';
        return; 
    }

    recognition = new SpeechRecognition();
    recognition.lang = document.getElementById('user-language').value || 'es-ES';
    recognition.continuous = true; // Seguir escuchando
    recognition.interimResults = true; // Mostrar resultados intermedios
    
    finalTranscript = ''; // Reiniciar transcripción final

    recognition.onresult = (event) => {
        interimTranscript = '';
        for (let i = event.resultIndex; i < event.results.length; ++i) {
            if (event.results[i].isFinal) {
                finalTranscript += event.results[i][0].transcript + ' ';
            } else {
                interimTranscript += event.results[i][0].transcript;
            }
        }
        
        // Actualizar UI con transcripción en vivo
        const statusEl = document.getElementById('recording-status');
        if (statusEl) {
             statusEl.textContent = 'Transcribiendo: ' + interimTranscript;
        }
    };

    recognition.onerror = (event) => {
        console.error('SpeechRecognition error:', event.error);
        const statusEl = document.getElementById('recording-status');
        if (event.error === 'no-speech' || event.error === 'audio-capture') {
             statusEl.textContent = 'Error de audio. Reintentando...';
        } else {
            statusEl.textContent = 'Error de transcripción.';
        }
    };
    
    recognition.onend = () => {
        console.log('SpeechRecognition detenido.');
        const statusEl = document.getElementById('recording-status');
        if (mediaRecorder && mediaRecorder.state === 'recording') {
            // Si la grabación sigue pero el reconocimiento paró (ej. por inactividad), reiniciarlo.
             console.log('Reiniciando SpeechRecognition...');
             if(recognition) recognition.start();
        } else {
            statusEl.textContent = 'Transcripción finalizada.';
        }
    };

    try {
        recognition.start();
        console.log('Iniciando transcripción en vivo...');
        document.getElementById('recording-status').textContent = 'Escuchando...';
    } catch (error) {
        console.error('Error al iniciar SpeechRecognition:', error);
    }
}

/**
 * Detiene la API de SpeechRecognition
 */
function stopLiveTranscription() {
    if (recognition) {
        recognition.stop();
        recognition = null;
    }
}


// --- LÓGICA DE LA IA (GEMINI) ---

/**
 * Botón principal para procesar la reunión con IA
 */
async function processMeetingWithAI() {
    const meetingId = this.dataset.meetingId;
    const aiErrorMsg = document.getElementById('ai-error-message');
    const generateButton = document.getElementById('generate-ai-summary-button');
    const summaryEmptyState = document.getElementById('summary-empty-state');
    const summaryLoadingState = document.getElementById('summary-loading-state');
    const summaryContent = document.getElementById('summary-content');

    aiErrorMsg.textContent = '';

    // 1. Validar API Key
    if (!GEMINI_API_KEY) {
        aiErrorMsg.textContent = 'La clave API de Gemini no está configurada.';
        showAlertModal("Error de Configuración", "La clave API de Gemini no está configurada en el código. No se puede procesar la IA.");
        return;
    }

    // 2. Obtener la transcripción
    const meeting = await dbGet(STORES.MEETINGS, meetingId);
    let transcriptText = meeting.transcript;

    // Si la transcripción está vacía (no se grabó en vivo o falló), intentar obtenerla del store de transcripciones (edición manual)
    if (!transcriptText || transcriptText.trim() === '') {
        const manualTranscript = await dbGet(STORES.TRANSCRIPTS, meetingId);
        if (manualTranscript && manualTranscript.text) {
            transcriptText = manualTranscript.text;
        }
    }

    // 3. Validar transcripción
    if (!transcriptText || transcriptText.trim() === '') {
        aiErrorMsg.textContent = 'La transcripción está vacía. Ve a la pestaña "Transcripción" y añade el texto manualmente.';
        return;
    }

    // 4. Actualizar UI a estado de "Cargando"
    summaryEmptyState.classList.add('hidden');
    summaryLoadingState.classList.remove('hidden');
    generateButton.disabled = true;

    try {
        // 5. Llamar a Gemini
        const summaryData = await getGeminiSummary(transcriptText, meeting);
        
        // 6. Guardar los resultados
        await saveAISummary(meetingId, summaryData);

        // 7. Renderizar el resumen
        renderSummaryInModal(summaryData);
        summaryLoadingState.classList.add('hidden');
        summaryContent.classList.remove('hidden');
        
        // 8. Actualizar estado de la reunión
        meeting.aiStatus = 'done';
        await dbPut(STORES.MEETINGS, meeting);
        
        // 9. Actualizar el Dashboard
        renderDashboard();

    } catch (error) {
        console.error('Error al procesar con Gemini:', error);
        aiErrorMsg.textContent = `Error de la API: ${error.message}`;
        summaryLoadingState.classList.add('hidden');
        summaryEmptyState.classList.remove('hidden');
    } finally {
        generateButton.disabled = false;
    }
}

/**
 * Llama a la API de Gemini para obtener el resumen estructurado
 */
async function getGeminiSummary(transcriptText, meeting) {
    console.log("Enviando transcripción a Gemini...");

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
                        "nombre": { "type": "STRING" },
                        "aportes": { "type": "STRING" }
                    },
                    "required": ["nombre", "aportes"]
                }
            },
            "puntos_relevantes": { "type": "ARRAY", "items": { "type": "STRING" } },
            "plan_de_accion": {
                "type": "ARRAY",
                "items": {
                    "type": "OBJECT",
                    "properties": {
                        "tarea": { "type": "STRING" },
                        "responsable": { "type": "STRING" },
                        "fecha_limite": { "type": "STRING", "description": "Formato AAAA-MM-DD o 'Por definir'" },
                        "prioridad": { "type": "STRING", "enum": ["Alta", "Media", "Baja"] },
                        "estado": { "type": "STRING", "default": "Pendiente" }
                    },
                    "required": ["tarea", "responsable", "fecha_limite", "prioridad"]
                }
            },
            "temas": { "type": "ARRAY", "items": { "type": "STRING" } }
        },
        required: ["titulo", "fecha", "hora", "resumen_general", "objetivo_general", "desarrollo_por_participante", "puntos_relevantes", "plan_de_accion", "temas"]
    };

    const systemPrompt = `Eres un asistente experto que sintetiza reuniones en español a partir de una transcripción.
Tu objetivo es devolver SIEMPRE un único objeto JSON válido que se adhiera estrictamente al esquema proporcionado.
Usa la fecha ${new Date(meeting.startAt).toISOString().split('T')[0]} y la hora ${new Date(meeting.startAt).toTimeString().substr(0,5)} - ${new Date(meeting.endAt).toTimeString().substr(0,5)}.
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
            responseSchema: schema,
            temperature: 0.3,
        },
    };

    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${GEMINI_API_KEY}`;

    const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Error de la API de Gemini: ${response.status} ${response.statusText} - ${errorBody}`);
    }

    const result = await response.json();
    
    if (result.candidates && result.candidates.length > 0 &&
        result.candidates[0].content && result.candidates[0].content.parts &&
        result.candidates[0].content.parts.length > 0) {
        
        try {
            const jsonText = result.candidates[0].content.parts[0].text;
            const parsedJson = JSON.parse(jsonText);
            return parsedJson;
        } catch (e) {
            console.error("Error al parsear el JSON de la respuesta de Gemini:", e);
            console.error("Respuesta de Gemini (texto):", result.candidates[0].content.parts[0].text);
            throw new Error("La API de IA devolvió un JSON inválido.");
        }
    } else {
        throw new Error("Respuesta de la API de IA inesperada o vacía.");
    }
}

/**
 * Guarda el resumen y las tareas de acción en IndexedDB
 */
async function saveAISummary(meetingId, summaryData) {
    // 1. Guardar el resumen principal
    const summaryRecord = {
        meetingId: meetingId,
        data: summaryData,
        createdAt: new Date().toISOString()
    };
    await dbPut(STORES.SUMMARIES, summaryRecord);

    // 2. Borrar tareas antiguas de esta reunión (si existen)
    const allTasks = await dbGetAll(STORES.ACTION_ITEMS);
    const oldTasks = allTasks.filter(task => task.meetingId === meetingId);
    for (const task of oldTasks) {
        await dbDelete(STORES.ACTION_ITEMS, task.id);
    }

    // 3. Guardar las nuevas tareas
    if (summaryData.plan_de_accion && summaryData.plan_de_accion.length > 0) {
        for (const item of summaryData.plan_de_accion) {
            const newTask = {
                id: `task_${meetingId}_${Date.now()}_${Math.random().toString(16).slice(2)}`,
                meetingId: meetingId,
                title: item.tarea,
                assignee: item.responsable,
                dueDate: item.fecha_limite,
                priority: item.prioridad,
                status: item.estado || 'Pendiente', // 'Pendiente', 'En curso', 'Hecha'
                createdAt: new Date().toISOString()
            };
            await dbAdd(STORES.ACTION_ITEMS, newTask);
        }
    }
    console.log(`Resumen y ${summaryData.plan_de_accion.length} tareas guardadas para ${meetingId}`);
}


// --- LÓGICA DE UI (HISTORIAL, MODAL, DASHBOARD) ---

/**
 * Actualiza la UI del botón de grabación y el temporizador
 */
function updateRecordingUI(isRecording) {
    const recordButton = document.getElementById('record-button');
    const recordIconMic = document.getElementById('record-icon-mic');
    const recordIconStop = document.getElementById('record-icon-stop');
    const recordRing = document.getElementById('record-ring');
    const recordDot = document.getElementById('record-dot');
    const timerDisplay = document.getElementById('timer-display');
    const recordingStatus = document.getElementById('recording-status');

    if (isRecording) {
        recordButton.classList.add('bg-red-700');
        recordButton.classList.remove('bg-gray-700');
        recordIconMic.classList.add('hidden');
        recordIconStop.classList.remove('hidden');
        recordRing.classList.remove('hidden');
        recordDot.classList.remove('hidden');
        // El estado de grabación (Escuchando... Transcribiendo...) lo maneja 'startLiveTranscription'
    } else {
        recordButton.classList.remove('bg-red-700');
        recordButton.classList.add('bg-gray-700');
        recordIconMic.classList.remove('hidden');
        recordIconStop.classList.add('hidden');
        recordRing.classList.add('hidden');
        recordDot.classList.add('hidden');
        timerDisplay.textContent = '00:00:00';
        recordingStatus.textContent = 'Grabación guardada.';
        setTimeout(() => { recordingStatus.textContent = ''; }, 3000);
    }
}

/**
 * Inicia el temporizador de grabación
 */
function startTimer() {
    const timerDisplay = document.getElementById('timer-display');
    timerInterval = setInterval(() => {
        const elapsed = new Date(new Date() - recordingStartTime);
        const hours = String(elapsed.getUTCHours()).padStart(2, '0');
        const minutes = String(elapsed.getUTCMinutes()).padStart(2, '0');
        const seconds = String(elapsed.getUTCSeconds()).padStart(2, '0');
        timerDisplay.textContent = `${hours}:${minutes}:${seconds}`;
    }, 1000);
}

/**
 * Detiene el temporizador de grabación
 */
function stopTimer() {
    clearInterval(timerInterval);
}

/**
 * Renderiza la lista de reuniones en el historial
 */
async function renderHistoryList() {
    const meetings = await dbGetAll(STORES.MEETINGS);
    meetings.sort((a, b) => new Date(b.startAt) - new Date(a.startAt)); // Más recientes primero

    const listUl = document.getElementById('history-list');
    const emptyState = document.getElementById('history-empty-state');
    const searchTerm = document.getElementById('search-history').value.toLowerCase();

    // Filtrar por búsqueda
    const filteredMeetings = meetings.filter(meeting => 
        meeting.title.toLowerCase().includes(searchTerm) ||
        (meeting.tags && meeting.tags.some(tag => tag.toLowerCase().includes(searchTerm))) ||
        (meeting.transcript && meeting.transcript.toLowerCase().includes(searchTerm)) // Buscar en transcripción
    );

    if (filteredMeetings.length === 0) {
        listUl.innerHTML = '';
        emptyState.classList.remove('hidden');
        return;
    }

    emptyState.classList.add('hidden');
    listUl.innerHTML = filteredMeetings.map(meeting => {
        const startDate = new Date(meeting.startAt);
        const durationMs = meeting.duration;
        const durationSec = Math.floor((durationMs / 1000) % 60);
        const durationMin = Math.floor((durationMs / (1000 * 60)) % 60);
        const durationHr = Math.floor(durationMs / (1000 * 60 * 60));

        const durationString = [
            durationHr > 0 ? `${durationHr}h` : null,
            durationMin > 0 ? `${durationMin}m` : null,
            `${durationSec}s`
        ].filter(Boolean).join(' ');

        const tagsHtml = (meeting.tags || [])
            .map(tag => `<span class="px-2 py-0.5 bg-cyan-700 text-cyan-100 text-xs font-medium rounded-full">${tag}</span>`)
            .join('');
        
        let statusHtml = '';
        if (meeting.aiStatus === 'pending') {
            statusHtml = `<div class="mt-3 text-xs text-yellow-400">Pendiente de IA</div>`;
        } else if (meeting.aiStatus === 'done') {
            statusHtml = `<div class="mt-3 text-xs text-green-400">Minuta Generada</div>`;
        }

        return `
            <li class="bg-gray-800 p-4 rounded-lg shadow-md cursor-pointer hover:bg-gray-700 transition-colors duration-200" data-meeting-id="${meeting.id}">
                <h3 class="text-lg font-semibold text-white">${meeting.title}</h3>
                <p class="text-sm text-gray-400">${startDate.toLocaleString()}  •  ${durationString}</p>
                <div class="mt-3 flex flex-wrap gap-2">${tagsHtml}</div>
                ${statusHtml}
            </li>
        `;
    }).join('');

    // Agregar listeners a los nuevos items de la lista
    listUl.querySelectorAll('li').forEach(item => {
        item.addEventListener('click', () => openMeetingDetailModal(item.dataset.meetingId));
    });
}

/**
 * Renderiza el dashboard con KPIs
 */
async function renderDashboard() {
    const allMeetings = await dbGetAll(STORES.MEETINGS);
    const allSummaries = await dbGetAll(STORES.SUMMARIES);
    const allActionItems = await dbGetAll(STORES.ACTION_ITEMS);

    // KPI: Tiempo Total
    const meetingsLast30Days = allMeetings.filter(m => {
        const meetingDate = new Date(m.startAt);
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        return meetingDate > thirtyDaysAgo;
    });
    const totalMs = meetingsLast30Days.reduce((acc, m) => acc + m.duration, 0);
    const totalHours = Math.floor(totalMs / (1000 * 60 * 60));
    const totalMinutes = Math.floor((totalMs % (1000 * 60 * 60)) / (1000 * 60));
    document.getElementById('kpi-total-time').textContent = `${totalHours}h ${totalMinutes}m`;

    // KPI: Tareas Abiertas
    const openTasks = allActionItems.filter(t => t.status !== 'Hecha');
    document.getElementById('kpi-open-tasks').textContent = openTasks.length;

    // KPI: % con Plan de Acción
    const meetingsWithSummaries = allSummaries.length;
    const meetingsWithActions = allSummaries.filter(s => s.data.plan_de_accion && s.data.plan_de_accion.length > 0).length;
    const pctWithActions = allMeetings.length > 0 ? Math.round((meetingsWithActions / allMeetings.length) * 100) : 0;
    document.getElementById('kpi-meetings-with-actions').textContent = `${pctWithActions}%`;

    // KPI: Efectividad (Simulado, ya que la fórmula es compleja)
    // En un futuro, se calcularía según la fórmula del doc.
    document.getElementById('kpi-avg-effectiveness').textContent = 'N/A';
    
    // Renderizar lista de Tareas Abiertas
    renderOpenTasks(openTasks);

    // Renderizar Temas Frecuentes
    renderFrequentTopics(allSummaries);
}

/**
 * Muestra las tareas abiertas en el dashboard
 */
function renderOpenTasks(openTasks) {
    const tasksList = document.getElementById('tasks-list');
    const tasksEmptyState = document.getElementById('tasks-empty-state');
    
    const tasksToShow = openTasks.slice(0, 10); // Limitar a 10
    
    if (tasksToShow.length === 0) {
        tasksEmptyState.classList.remove('hidden');
        tasksList.innerHTML = '';
        return;
    }
    
    tasksEmptyState.classList.add('hidden');
    tasksList.innerHTML = tasksToShow.map(task => {
        let priorityClass = 'bg-gray-500';
        if (task.priority === 'Alta') priorityClass = 'bg-red-600';
        if (task.priority === 'Media') priorityClass = 'bg-yellow-600';
        if (task.priority === 'Baja') priorityClass = 'bg-green-600';
        
        return `
            <li class="bg-gray-800 p-3 rounded-lg flex items-center justify-between">
                <div>
                    <p class="text-white">${task.title}</p>
                    <p class="text-xs text-gray-400">Resp: ${task.assignee} | Límite: ${task.dueDate}</p>
                </div>
                <span class="px-2 py-0.5 ${priorityClass} text-white text-xs font-medium rounded-full">${task.priority}</span>
            </li>
        `;
    }).join('');
}

/**
 * Muestra los temas frecuentes en el dashboard
 */
function renderFrequentTopics(allSummaries) {
    const topicsList = document.getElementById('topics-list');
    const topicsEmptyState = document.getElementById('topics-empty-state');
    
    const topicCounts = {};
    allSummaries.forEach(summary => {
        if (summary.data.temas) {
            summary.data.temas.forEach(topic => {
                topicCounts[topic] = (topicCounts[topic] || 0) + 1;
            });
        }
    });
    
    const sortedTopics = Object.entries(topicCounts).sort((a, b) => b[1] - a[1]).slice(0, 10); // Top 10

    if (sortedTopics.length === 0) {
        topicsEmptyState.classList.remove('hidden');
        topicsList.innerHTML = '';
        return;
    }

    topicsEmptyState.classList.add('hidden');
    topicsList.innerHTML = sortedTopics.map(([topic, count]) => {
        return `<span class="px-3 py-1 bg-cyan-700 text-cyan-100 text-sm rounded-full">${topic} (${count})</span>`;
    }).join('');
}


// --- LÓGICA DEL MODAL (ABRIR, CERRAR, POBLAR) ---

/**
 * Abre el modal de detalle y carga sus datos
 */
async function openMeetingDetailModal(meetingId) {
    const modal = document.getElementById('meeting-detail-modal');
    const backdrop = document.getElementById('modal-backdrop');
    
    // Guardar el ID en el modal para referencia
    modal.dataset.currentMeetingId = meetingId;
    
    // Resetear estado del modal
    resetModalViews();
    
    // Cargar datos
    const meeting = await dbGet(STORES.MEETINGS, meetingId);
    
    // Pestaña Acciones (Metadatos)
    document.getElementById('modal-edit-title').value = meeting.title;
    document.getElementById('modal-edit-tags').value = (meeting.tags || []).join(', ');
    
    // Pestaña Acciones (Reproductor de audio)
    const audioPlayerContainer = document.getElementById('modal-audio-player-container');
    const audioPlayer = document.getElementById('modal-audio-player');
    if (meeting.audioBlob) {
        const audioUrl = URL.createObjectURL(meeting.audioBlob);
        audioPlayer.src = audioUrl;
        audioPlayerContainer.classList.remove('hidden');
        audioPlayer.onended = () => URL.revokeObjectURL(audioUrl);
    } else {
        audioPlayerContainer.classList.add('hidden');
    }

    // Pestaña Acciones (Botones)
    document.getElementById('modal-save-metadata-button').dataset.meetingId = meetingId;
    document.getElementById('modal-delete-button').dataset.meetingId = meetingId;
    document.getElementById('generate-ai-summary-button').dataset.meetingId = meetingId;
    document.getElementById('modal-export-json-button').dataset.meetingId = meetingId;

    // Pestaña Transcripción
    await renderTranscriptInModal(meetingId, meeting.transcript);
    
    // Pestaña Resumen/Minuta
    const summary = await dbGet(STORES.SUMMARIES, meetingId);
    if (summary) {
        renderSummaryInModal(summary.data);
        document.getElementById('summary-empty-state').classList.add('hidden');
        document.getElementById('summary-loading-state').classList.add('hidden');
        document.getElementById('summary-content').classList.remove('hidden');
    } else {
        // Estado vacío, listo para generar
        document.getElementById('summary-empty-state').classList.remove('hidden');
        document.getElementById('summary-loading-state').classList.add('hidden');
        document.getElementById('summary-content').classList.add('hidden');
    }

    // Mostrar modal
    modal.classList.add('active');
    backdrop.classList.add('active');
}

/**
 * Cierra el modal de detalle
 */
function closeMeetingDetailModal() {
    const modal = document.getElementById('meeting-detail-modal');
    const backdrop = document.getElementById('modal-backdrop');
    
    // Detener audio si se está reproduciendo
    const audioPlayer = document.getElementById('modal-audio-player');
    audioPlayer.pause();
    audioPlayer.src = '';
    
    modal.classList.remove('active');
    backdrop.classList.remove('active');
    modal.dataset.currentMeetingId = '';
}

/**
 * Resetea las vistas del modal a su estado por defecto
 */
function resetModalViews() {
    // Pestañas
    document.querySelectorAll('.modal-tab-button').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.modal-tab-content').forEach(content => content.classList.remove('active'));
    document.querySelector('.modal-tab-button[data-tab="summary"]').classList.add('active');
    document.getElementById('modal-tab-summary').classList.add('active');
    
    // Estado de IA
    document.getElementById('summary-empty-state').classList.add('hidden');
    document.getElementById('summary-loading-state').classList.add('hidden');
    document.getElementById('summary-content').classList.add('hidden');
    document.getElementById('ai-error-message').textContent = '';

    // Transcripción
    document.getElementById('transcript-editor-container').classList.add('hidden');
    document.getElementById('transcript-status-message').classList.add('hidden');
    document.getElementById('save-transcript-button').classList.add('hidden');
}

/**
 * Muestra el resumen de IA en el modal
 */
function renderSummaryInModal(summaryData) {
    document.getElementById('summary-overview').textContent = summaryData.resumen_general;
    document.getElementById('summary-objective').textContent = summaryData.objetivo_general;
    
    document.getElementById('summary-participants').innerHTML = summaryData.desarrollo_por_participante
        .map(p => `<li><strong>${p.nombre}:</strong> ${p.aportes}</li>`)
        .join('');
    
    document.getElementById('summary-keypoints').innerHTML = summaryData.puntos_relevantes
        .map(p => `<li>${p}</li>`)
        .join('');
    
    document.getElementById('summary-actionplan').innerHTML = summaryData.plan_de_accion
        .map(task => `
            <div class="p-2 bg-gray-700 rounded-md">
                <p><strong>Tarea:</strong> ${task.tarea}</p>
                <p class="text-sm"><strong>Resp:</strong> ${task.responsable} | <strong>Límite:</strong> ${task.fecha_limite} | <strong>Prio:</strong> ${task.prioridad}</p>
            </div>
        `)
        .join('');
        
    document.getElementById('summary-topics').innerHTML = summaryData.temas
        .map(topic => `<span class="px-2 py-0.5 bg-cyan-700 text-cyan-100 text-xs font-medium rounded-full">${topic}</span>`)
        .join('');
}

/**
 * Muestra la transcripción en el modal
 */
async function renderTranscriptInModal(meetingId, liveTranscript) {
    const editorContainer = document.getElementById('transcript-editor-container');
    const editor = document.getElementById('transcript-editor');
    const statusMessage = document.getElementById('transcript-status-message');
    const saveButton = document.getElementById('save-transcript-button');
    
    // 1. Intentar cargar una transcripción editada manualmente
    const manualTranscript = await dbGet(STORES.TRANSCRIPTS, meetingId);
    
    let textToDisplay = '';
    if (manualTranscript && manualTranscript.text) {
        textToDisplay = manualTranscript.text;
    } else if (liveTranscript) {
        textToDisplay = liveTranscript;
    }
    
    saveButton.dataset.meetingId = meetingId;
    
    if (textToDisplay.trim() !== '') {
        editor.textContent = textToDisplay;
        editorContainer.classList.remove('hidden');
        saveButton.classList.remove('hidden');
        statusMessage.classList.add('hidden');
    } else {
        editor.textContent = '';
        editorContainer.classList.add('hidden');
        saveButton.classList.add('hidden');
        statusMessage.textContent = 'La transcripción en vivo no grabó texto o no es soportada. Puedes añadir el texto manualmente aquí.';
        statusMessage.classList.remove('hidden');
        
        // Habilitar el editor aunque esté vacío para añadir manually
        editorContainer.classList.remove('hidden');
        saveButton.classList.remove('hidden'); // Mostrar botón de guardar
    }
}

/**
 * Guarda los cambios manuales de la transcripción
 */
async function saveTranscriptChanges() {
    const meetingId = this.dataset.meetingId;
    const newText = document.getElementById('transcript-editor').textContent;
    
    const transcriptRecord = {
        meetingId: meetingId,
        text: newText,
        updatedAt: new Date().toISOString()
    };
    
    try {
        await dbPut(STORES.TRANSCRIPTS, transcriptRecord);
        // Opcional: mostrar un mensaje de "Guardado"
        console.log('Transcripción manual guardada');
        
        // También actualizar el registro principal de la reunión (opcional pero bueno para IA)
        const meeting = await dbGet(STORES.MEETINGS, meetingId);
        meeting.transcript = newText;
        await dbPut(STORES.MEETINGS, meeting);
        
        // Mostrar feedback
        const saveButton = document.getElementById('save-transcript-button');
        const originalText = saveButton.textContent;
        saveButton.textContent = '¡Guardado!';
        saveButton.disabled = true;
        setTimeout(() => {
            saveButton.textContent = originalText;
            saveButton.disabled = false;
        }, 2000);
        
    } catch (error) {
        console.error('Error al guardar la transcripción manual:', error);
    }
}


// --- LÓGICA DE ACCIONES (GUARDAR, BORRAR, EXPORTAR) ---

/**
 * Guarda los metadatos (título, tags) editados en el modal
 */
async function saveModalMetadata() {
    const meetingId = this.dataset.meetingId;
    const newTitle = document.getElementById('modal-edit-title').value;
    const newTags = document.getElementById('modal-edit-tags').value
        .split(',')
        .map(tag => tag.trim())
        .filter(tag => tag); // Quitar tags vacíos
        
    try {
        const meeting = await dbGet(STORES.MEETINGS, meetingId);
        meeting.title = newTitle;
        meeting.tags = newTags;
        
        await dbPut(STORES.MEETINGS, meeting);
        
        console.log('Metadatos guardados');
        closeMeetingDetailModal();
        renderHistoryList(); // Refrescar historial
    } catch (error) {
        console.error('Error al guardar metadatos:', error);
    }
}

/**
 * Maneja el clic en el botón de borrar reunión (muestra confirmación)
 */
function handleDeleteMeetingClick() {
    const meetingId = this.dataset.meetingId;
    
    showAlertModal(
        "¿Eliminar Reunión?",
        "Esta acción es irreversible y borrará el audio, la transcripción y la minuta de IA.",
        async () => {
            await deleteMeeting(meetingId);
            closeMeetingDetailModal();
            renderHistoryList();
            renderDashboard();
        }
    );
}

/**
 * Borra una reunión de todas las tablas de la DB
 */
async function deleteMeeting(meetingId) {
    try {
        // Borrar reunión
        await dbDelete(STORES.MEETINGS, meetingId);
        // Borrar transcripción
        await dbDelete(STORES.TRANSCRIPTS, meetingId);
        // Borrar resumen
        await dbDelete(STORES.SUMMARIES, meetingId);
        // Borrar tareas
        const allTasks = await dbGetAll(STORES.ACTION_ITEMS);
        const tasksToDelete = allTasks.filter(task => task.meetingId === meetingId);
        for (const task of tasksToDelete) {
            await dbDelete(STORES.ACTION_ITEMS, task.id);
        }
        console.log(`Reunión ${meetingId} eliminada`);
    } catch (error) {
        console.error(`Error al eliminar la reunión ${meetingId}:`, error);
    }
}

/**
 * Maneja el clic en el botón de borrar TODOS los datos (muestra confirmación)
 */
function handleDeleteAllDataClick() {
    showAlertModal(
        "¿Borrar Todos los Datos?",
        "¡Acción irreversible! Esto borrará TODAS las reuniones, audios, transcripciones y minutas de tu dispositivo.",
        async () => {
            await dbClear(STORES.MEETINGS);
            await dbClear(STORES.TRANSCRIPTS);
            await dbClear(STORES.SUMMARIES);
            await dbClear(STORES.ACTION_ITEMS);
            console.log("Todos los datos han sido borrados.");
            renderHistoryList();
            renderDashboard();
        }
    );
}

/**
 * Exporta una reunión específica como JSON
 */
async function exportMeetingAsJSON() {
    const meetingId = this.dataset.meetingId;
    try {
        const meeting = await dbGet(STORES.MEETINGS, meetingId);
        const transcript = await dbGet(STORES.TRANSCRIPTS, meetingId);
        const summary = await dbGet(STORES.SUMMARIES, meetingId);
        const allTasks = await dbGetAll(STORES.ACTION_ITEMS);
        const tasks = allTasks.filter(t => t.meetingId === meetingId);

        // Quitar el audio blob para exportar, es demasiado grande
        const meetingData = { ...meeting };
        delete meetingData.audioBlob; 

        const exportData = {
            meeting: meetingData,
            transcript: transcript || null,
            summary: summary || null,
            actionItems: tasks
        };
        
        downloadJSON(exportData, `meeting_${meetingId}.json`);

    } catch (error) {
        console.error("Error al exportar reunión:", error);
    }
}

/**
 * Exporta TODOS los datos de la aplicación como un solo JSON
 */
async function exportAllData() {
    try {
        const meetings = await dbGetAll(STORES.MEETINGS);
        const transcripts = await dbGetAll(STORES.TRANSCRIPTS);
        const summaries = await dbGetAll(STORES.SUMMARIES);
        const actionItems = await dbGetAll(STORES.ACTION_ITEMS);

        // Quitar blobs de audio
        const meetingsData = meetings.map(m => {
            const data = { ...m };
            delete data.audioBlob;
            return data;
        });

        const exportData = {
            meetings: meetingsData,
            transcripts: transcripts,
            summaries: summaries,
            actionItems: actionItems
        };

        downloadJSON(exportData, 'meetingmind_backup.json');

    } catch (error) {
        console.error("Error al exportar todos los datos:", error);
    }
}

/**
 * Función helper para descargar un objeto JSON como un archivo
 */
function downloadJSON(data, filename) {
    const jsonStr = JSON.stringify(data, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}


// --- LÓGICA DE MODAL DE ALERTA (CONFIRMACIÓN) ---

/**
 * Muestra un modal de alerta/confirmación
 */
function showAlertModal(title, message, onConfirmCallback) {
    const modal = document.getElementById('alert-modal');
    const backdrop = document.getElementById('alert-modal-backdrop');
    
    document.getElementById('alert-modal-title').textContent = title;
    document.getElementById('alert-modal-message').textContent = message;
    
    const confirmButton = document.getElementById('alert-modal-confirm');
    
    // Clonar el botón para limpiar listeners antiguos
    const newConfirmButton = confirmButton.cloneNode(true);
    confirmButton.parentNode.replaceChild(newConfirmButton, confirmButton);
    
    newConfirmButton.onclick = () => {
        if (onConfirmCallback) {
            onConfirmCallback();
        }
        closeAlertModal();
    };
    
    modal.classList.add('active');
    backdrop.classList.add('active');
}

/**
 * Cierra el modal de alerta
 */
function closeAlertModal() {
    document.getElementById('alert-modal').classList.remove('active');
    document.getElementById('alert-modal-backdrop').classList.remove('active');
}


// --- HELPERS DE BASE DE DATOS (IndexedDB) ---

/**
 * Inicializa la base de datos IndexedDB
 */
function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (event) => {
            const dbInstance = event.target.result;
            // Almacén de Reuniones (metadatos + audio)
            if (!dbInstance.objectStoreNames.contains(STORES.MEETINGS)) {
                dbInstance.createObjectStore(STORES.MEETINGS, { keyPath: 'id' });
            }
            // Almacén de Transcripciones (para edición manual)
            if (!dbInstance.objectStoreNames.contains(STORES.TRANSCRIPTS)) {
                dbInstance.createObjectStore(STORES.TRANSCRIPTS, { keyPath: 'meetingId' });
            }
            // Almacén de Resúmenes (JSON de IA)
            if (!dbInstance.objectStoreNames.contains(STORES.SUMMARIES)) {
                dbInstance.createObjectStore(STORES.SUMMARIES, { keyPath: 'meetingId' });
            }
            // Almacén de Tareas
            if (!dbInstance.objectStoreNames.contains(STORES.ACTION_ITEMS)) {
                dbInstance.createObjectStore(STORES.ACTION_ITEMS, { keyPath: 'id' });
            }
            console.log('IndexedDB actualizado a la versión', DB_VERSION);
        };

        request.onsuccess = (event) => {
            db = event.target.result;
            console.log('Base de datos inicializada:', db);
            resolve(db);
        };

        request.onerror = (event) => {
            console.error('Error al abrir la base de datos:', event.target.error);
            reject(event.target.error);
        };
    });
}

// Helpers genéricos de DB (promisificados)
function dbTransaction(storeName, mode) {
    return db.transaction(storeName, mode).objectStore(storeName);
}

function dbGet(storeName, key) {
    return new Promise((resolve, reject) => {
        const request = dbTransaction(storeName, 'readonly').get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = (event) => reject(event.target.error);
    });
}

function dbGetAll(storeName) {
    return new Promise((resolve, reject) => {
        const request = dbTransaction(storeName, 'readonly').getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = (event) => reject(event.target.error);
    });
}

function dbAdd(storeName, value) {
    return new Promise((resolve, reject) => {
        const request = dbTransaction(storeName, 'readwrite').add(value);
        request.onsuccess = () => resolve(request.result);
        request.onerror = (event) => reject(event.target.error);
    });
}

function dbPut(storeName, value) {
    return new Promise((resolve, reject) => {
        const request = dbTransaction(storeName, 'readwrite').put(value);
        request.onsuccess = () => resolve(request.result);
        request.onerror = (event) => reject(event.target.error);
    });
}

function dbDelete(storeName, key) {
    return new Promise((resolve, reject) => {
        const request = dbTransaction(storeName, 'readwrite').delete(key);
        request.onsuccess = () => resolve();
        request.onerror = (event) => reject(event.target.error);
    });
}

function dbClear(storeName) {
    return new Promise((resolve, reject) => {
        const request = dbTransaction(storeName, 'readwrite').clear();
        request.onsuccess = () => resolve();
        request.onerror = (event) => reject(event.target.error);
    });
}
