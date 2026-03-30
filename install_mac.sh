#!/bin/bash
# ============================================================
# install_mac.sh — Instalador del servidor de impresión CajaOS
# Requiere ejecutarse con sudo: sudo bash install_mac.sh
# ============================================================

set -e

BINARY_NAME="cajaos-print-server"
INSTALL_DIR="/usr/local/bin"
PLIST_NAME="com.cajaos.printserver.plist"
PLIST_DIR="/Library/LaunchDaemons"
LOG_DIR="/var/log"

# ---- Detectar arquitectura ----
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
  SRC_BINARY="./dist/${BINARY_NAME}-arm64"
  echo "→ Detectado: Apple Silicon (arm64)"
else
  SRC_BINARY="./dist/${BINARY_NAME}-x64"
  echo "→ Detectado: Intel (x86_64)"
fi

# ---- Verificar que existe el binario ----
if [ ! -f "$SRC_BINARY" ]; then
  echo "❌ No se encontró el binario: $SRC_BINARY"
  echo "   Ejecutá primero: npm run build  (en la carpeta del proyecto)"
  exit 1
fi

# ---- Verificar que existe el plist ----
if [ ! -f "./$PLIST_NAME" ]; then
  echo "❌ No se encontró el archivo: $PLIST_NAME"
  exit 1
fi

echo ""
echo "=== Instalando CajaOS Print Server ==="
echo ""

# ---- Detener servicio si ya estaba corriendo ----
if launchctl list | grep -q "com.cajaos.printserver"; then
  echo "→ Deteniendo servicio anterior..."
  launchctl unload "$PLIST_DIR/$PLIST_NAME" 2>/dev/null || true
fi

# ---- Copiar binario ----
echo "→ Copiando binario a $INSTALL_DIR/$BINARY_NAME ..."
cp "$SRC_BINARY" "$INSTALL_DIR/$BINARY_NAME"
chmod +x "$INSTALL_DIR/$BINARY_NAME"

# ---- Copiar plist ----
echo "→ Instalando LaunchDaemon en $PLIST_DIR ..."
cp "./$PLIST_NAME" "$PLIST_DIR/$PLIST_NAME"
chown root:wheel "$PLIST_DIR/$PLIST_NAME"
chmod 644 "$PLIST_DIR/$PLIST_NAME"

# ---- Crear archivos de log ----
touch "$LOG_DIR/cajaos-printserver.log"
touch "$LOG_DIR/cajaos-printserver-error.log"
chmod 644 "$LOG_DIR/cajaos-printserver.log"
chmod 644 "$LOG_DIR/cajaos-printserver-error.log"

# ---- Cargar y arrancar el servicio ----
echo "→ Cargando y arrancando el servicio..."
launchctl load "$PLIST_DIR/$PLIST_NAME"

# ---- Verificar que arrancó ----
sleep 2
if launchctl list | grep -q "com.cajaos.printserver"; then
  echo ""
  echo "✅ CajaOS Print Server instalado y corriendo en http://localhost:3001"
  echo ""
  echo "   Verificar salud:  curl http://localhost:3001/health"
  echo "   Ver logs:         tail -f /var/log/cajaos-printserver.log"
  echo "   Detener:          sudo launchctl unload $PLIST_DIR/$PLIST_NAME"
  echo "   Desinstalar:      sudo bash uninstall_mac.sh"
else
  echo ""
  echo "⚠️  El servicio no parece estar corriendo. Revisá los logs:"
  echo "   tail -f /var/log/cajaos-printserver-error.log"
  exit 1
fi
