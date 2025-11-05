// Nombramos la caché
const CACHE_NAME = 'meetingmind-v2'; // Versión actualizada

// Archivos clave para guardar en caché (el "App Shell")
const urlsToCache = [
    './index.html',
    './style.css',  // <-- AÑADIDO
    './app.js',     // <-- AÑADIDO
    './manifest.json',
    'https://cdn.tailwindcss.com',
    'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap'
    // Las fuentes específicas (ej. .woff2) se cachearán dinámicamente
];

// Evento 'install': se dispara cuando el SW se instala
self.addEventListener('install', event => {
    // Espera hasta que el cacheo esté completo
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                console.log('Cache abierto, agregando el App Shell v2');
                // Agrega todos los archivos del "App Shell" a la caché
                return cache.addAll(urlsToCache);
            })
    );
});

// Evento 'fetch': se dispara cada vez que la app pide un recurso (imagen, script, etc.)
self.addEventListener('fetch', event => {
    // Estrategia "Cache-First" (primero caché, luego red)
    event.respondWith(
        caches.match(event.request)
            .then(response => {
                // 1. Si está en la caché, lo devolvemos desde ahí
                if (response) {
                    return response;
                }
                
                // 2. Si no está en caché, lo pedimos a la red
                return fetch(event.request).then(
                    response => {
                        // Comprobar si la respuesta es válida
                        if(!response || response.status !== 200 || (response.type !== 'basic' && response.type !== 'opaque')) {
                            return response; // Devolver la respuesta tal cual (ej. de API de Gemini)
                        }

                        // Clonar la respuesta. La respuesta solo se puede "consumir" una vez.
                        const responseToCache = response.clone();

                        // Abrir nuestra caché y guardar la nueva respuesta
                        caches.open(CACHE_NAME)
                            .then(cache => {
                                // Solo cachear peticiones GET
                                if (event.request.method === 'GET') {
                                    cache.put(event.request, responseToCache);
                                }
                            });

                        // Devolver la respuesta original a la aplicación
                        return response;
                    }
                ).catch(error => {
                    // Error de red (offline)
                    console.warn('Fallo de red al buscar:', event.request.url, error.message);
                    // Aquí podrías devolver una página offline genérica si la tuvieras
                });
            })
    );
});

// Evento 'activate': se dispara cuando el SW se activa (ej. al cerrar y abrir la app)
// Se usa para limpiar cachés antiguas.
self.addEventListener('activate', event => {
    const cacheWhitelist = [CACHE_NAME]; // Solo queremos esta versión de caché
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cacheName => {
                    // Si la caché no está en nuestra "lista blanca", la borramos
                    if (cacheWhitelist.indexOf(cacheName) === -1) {
                        console.log('Borrando caché antigua:', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
});
