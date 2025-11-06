const CACHE_NAME = 'meetingmind-cache-v1.1';
const ASSETS_TO_CACHE = [
    './',
    './index.html',
    './style.css',
    './app.js',
    './manifest.json',
    'https://placehold.co/192x192/06b6d4/FFFFFF?text=MM', // Cache icon
    'https://placehold.co/512x512/06b6d4/FFFFFF?text=MM'  // Cache icon
];

// Evento install: se dispara cuando el SW se instala
self.addEventListener('install', event => {
    console.log('[SW] Instalando Service Worker...');
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                console.log('[SW] Cache abierto. Cacheando assets iniciales.');
                return cache.addAll(ASSETS_TO_CACHE);
            })
            .then(() => {
                console.log('[SW] Assets iniciales cacheados con éxito.');
                self.skipWaiting(); // Forza al SW a activarse
            })
            .catch(error => {
                console.error('[SW] Error al cachear assets iniciales:', error);
            })
    );
});

// Evento activate: se dispara cuando el SW se activa (limpia caches viejos)
self.addEventListener('activate', event => {
    console.log('[SW] Activando Service Worker...');
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cacheName => {
                    if (cacheName !== CACHE_NAME) {
                        console.log('[SW] Limpiando cache antiguo:', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );
        }).then(() => {
            console.log('[SW] Service Worker activado y caches limpios.');
            return self.clients.claim(); // Toma control de las páginas abiertas
        })
    );
});

// Evento fetch: intercepta todas las peticiones de red
self.addEventListener('fetch', event => {
    const request = event.request;

    // No cachear peticiones a la API de Gemini
    if (request.url.includes('generativelanguage.googleapis.com')) {
        event.respondWith(fetch(request));
        return;
    }

    // Estrategia: Cache, falling back to Network (Cache-First)
    event.respondWith(
        caches.match(request)
            .then(cachedResponse => {
                // Si la respuesta está en cache, la retornamos
                if (cachedResponse) {
                    // console.log('[SW] Retornando desde cache:', request.url);
                    return cachedResponse;
                }

                // Si no, la buscamos en la red
                // console.log('[SW] Buscando en red:', request.url);
                return fetch(request)
                    .then(networkResponse => {
                        // Clonamos la respuesta antes de guardarla en cache
                        const responseToCache = networkResponse.clone();
                        
                        // Guardamos la nueva respuesta en cache
                        caches.open(CACHE_NAME)
                            .then(cache => {
                                cache.put(request, responseToCache);
                            });

                        return networkResponse;
                    })
                    .catch(error => {
                        console.error('[SW] Error de fetch y no está en cache:', error);
                        // Opcional: retornar una página offline de fallback
                    });
            })
    );
});
