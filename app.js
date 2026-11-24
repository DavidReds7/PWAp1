// app.js - Lógica de UI, envío resiliente (Outbox) y degradación elegante.
// Solo Promesas explícitas (new Promise, then, catch, Promise.all).

const ENDPOINT = 'https://jsonplaceholder.typicode.com/posts';

// ---------- Service Worker y mensajes (Fragmento G, Tema 5.3) ----------
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js')
    .then((reg) => console.log('[App] SW registrado. Scope:', reg.scope))
    .catch((err) => console.error('[App] Error registrando SW:', err));

  // Mitad receptora del puente postMessage: el SW avisa que terminó de sincronizar.
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data && event.data.tipo === 'OUTBOX_SINCRONIZADO') {
      console.log('[UI] Confirmación recibida del Service Worker. Actualizando bandeja...');
      renderizarColaOutbox();
    }
  });
}

// ---------- Indicador de red ----------
function actualizarIndicadorRed() {
  const badge = document.getElementById('badge-red');
  if (navigator.onLine) {
    badge.textContent = 'En Línea';
    badge.className = 'badge online';
  } else {
    badge.textContent = 'Sin Conexión';
    badge.className = 'badge offline';
  }
}

// ---------- READ: pintar la bandeja de salida ----------
function renderizarColaOutbox() {
  const lista = document.getElementById('lista-outbox');

  return obtenerTodosLosRegistros().then((registros) => {
    lista.innerHTML = '';

    if (registros.length === 0) {
      const vacio = document.createElement('li');
      vacio.className = 'vacio';
      vacio.textContent = 'La bandeja está vacía.';
      lista.appendChild(vacio);
      return;
    }

    registros.forEach((item) => {
      const li = document.createElement('li');
      li.className = item.estado;

      const info = document.createElement('div');
      const titulo = document.createElement('strong');
      titulo.textContent = item.titulo; // textContent evita inyección de HTML
      const hora = document.createElement('span');
      hora.className = 'hora';
      hora.textContent = new Date(item.fechaCreacion).toLocaleString('es-MX');
      info.appendChild(titulo);
      info.appendChild(hora);

      const estado = document.createElement('span');
      estado.className = 'estado';
      estado.textContent = item.estado;

      li.appendChild(info);
      li.appendChild(estado);
      lista.appendChild(li);
    });
  });
}

// ---------- Encolar como pendiente y delegar al SW (Fragmento E, Tema 5.3) ----------
function encolarPendiente(datosFormulario) {
  return guardarRegistro({
    ...datosFormulario,
    estado: 'pendiente',
    fechaCreacion: Date.now()
  }).then(() => {
    // Detección de soporte de Background Sync
    if ('serviceWorker' in navigator && 'SyncManager' in window) {
      return navigator.serviceWorker.ready.then((registro) => {
        console.log('[Outbox] Registrando etiqueta sync-reportes en el SW...');
        return registro.sync.register('sync-reportes');
      });
    }
  });
}

// ---------- CREATE: envío resiliente (Fragmento B + E) ----------
function procesarEnvioReporte(datosFormulario) {
  return fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: datosFormulario.titulo, body: datosFormulario.descripcion })
  })
    .then((respuesta) => {
      if (!respuesta.ok) throw new Error('Error HTTP del servidor');
      return respuesta.json();
    })
    .then(
      () => {
        // Envío en vivo exitoso: bitácora local como 'sincronizado'
        return guardarRegistro({
          ...datosFormulario,
          estado: 'sincronizado',
          fechaCreacion: Date.now()
        });
      },
      () => {
        // Solo si FALLÓ la red/servidor: encolar. (Al usar el 2.º argumento de .then,
        // un error al guardar 'sincronizado' no se confunde con una falla de red.)
        console.warn('[Outbox] Sin conexión. Encolando en IndexedDB...');
        return encolarPendiente(datosFormulario);
      }
    )
    .then(() => renderizarColaOutbox());
}

// ---------- UPDATE: fallback por evento 'online' (Fragmento C renombrado) ----------
function sincronizarPendientesFallback() {
  console.log('[Outbox] Buscando registros pendientes...');

  return obtenerTodosLosRegistros()
    .then((registros) => {
      const pendientes = registros.filter((item) => item.estado === 'pendiente');

      if (pendientes.length === 0) {
        console.log('[Outbox] No hay transacciones pendientes por sincronizar.');
        return;
      }

      // Arreglo de objetos -> arreglo de promesas HTTP
      const promesasDeEnvio = pendientes.map((item) => {
        return fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: item.titulo, body: item.descripcion })
        }).then((res) => {
          if (!res.ok) throw new Error('Falla al reintentar envío');
          return actualizarEstadoRegistro(item.id, 'sincronizado');
        });
      });

      return Promise.all(promesasDeEnvio);
    })
    .then(() => renderizarColaOutbox())
    .catch((error) => {
      console.error('[Outbox] Error durante la sincronización masiva:', error);
    });
}

// ---------- Eventos de red (Fragmento F, Tema 5.3) ----------
window.addEventListener('online', () => {
  actualizarIndicadorRed();

  // Solo sincronizar desde la UI si NO hay Background Sync (Safari/iOS, Firefox).
  // En Chrome lo hace sw.js; hacerlo en ambos duplicaría los POST (race condition).
  if (!('SyncManager' in window)) {
    console.log('[Outbox] Navegador sin SyncManager. Ejecutando fallback por evento online...');
    sincronizarPendientesFallback();
  }
});

window.addEventListener('offline', actualizarIndicadorRed);

// ---------- Formulario (submit) ----------
document.getElementById('form-incidencia').addEventListener('submit', (e) => {
  e.preventDefault();

  const inputTitulo = document.getElementById('titulo');
  const inputDescripcion = document.getElementById('descripcion');

  const datos = {
    titulo: inputTitulo.value.trim(),
    descripcion: inputDescripcion.value.trim()
  };

  procesarEnvioReporte(datos)
    .then(() => {
      e.target.reset();
    })
    .catch((error) => {
      console.error('[Outbox] No se pudo procesar el reporte:', error);
    });
});

// ---------- DELETE: purgar sincronizados ----------
document.getElementById('btn-purgar').addEventListener('click', () => {
  obtenerTodosLosRegistros()
    .then((registros) => {
      const sincronizados = registros.filter((item) => item.estado === 'sincronizado');
      return Promise.all(sincronizados.map((item) => eliminarRegistro(item.id)));
    })
    .then(() => renderizarColaOutbox())
    .catch((error) => {
      console.error('[Outbox] Error al purgar:', error);
    });
});

// ---------- Arranque: READ inicial ----------
actualizarIndicadorRed();
renderizarColaOutbox().catch((error) => {
  console.error('[Outbox] Error al leer IndexedDB al iniciar:', error);
});

// Si el navegador abre la PWA con pendientes y ya hay red pero no hay SyncManager, reintentar.
if (navigator.onLine && !('SyncManager' in window)) {
  sincronizarPendientesFallback();
}
