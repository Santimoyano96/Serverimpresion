#!/bin/bash
# ============================================================
# uninstall_mac.sh — Desinstalador del servidor de impresión CajaOS
# Requiere ejecutarse con sudo: sudo bash uninstall_mac.sh
# ============================================================

BINARY_NAME="cajaos-print-server"
INSTALL_DIR="/usr/local/bin"
PLIST_NAME="com.cajaos.printserver.plist"
PLIST_DIR="/Library/LaunchDaemons"

echo "=== Desinstalando CajaOS Print Server ==="

# Detener y descargar el servicio
if [ -f "$PLIST_DIR/$PLIST_NAME" ]; then
  echo "→ Deteniendo y removiendo el servicio..."
  launchctl unload "$PLIST_DIR/$PLIST_NAME" 2>/dev/null || true
  rm -f "$PLIST_DIR/$PLIST_NAME"
fi

# Eliminar el binario
if [ -f "$INSTALL_DIR/$BINARY_NAME" ]; then
  echo "→ Eliminando binario..."
  rm -f "$INSTALL_DIR/$BINARY_NAME"
fi

echo ""
echo "✅ CajaOS Print Server desinstalado correctamente."
