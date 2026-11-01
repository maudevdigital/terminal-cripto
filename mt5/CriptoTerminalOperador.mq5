//+------------------------------------------------------------------+
//| CriptoTerminalOperador.mq5                                       |
//| Ejecuta las ordenes del panel Operar del Terminal Cripto: abrir   |
//| a mercado o con orden limite (con SL y TP), cerrar total o        |
//| parcial, modificar SL/TP y cancelar ordenes pendientes.           |
//|                                                                  |
//| ESTE EA SI OPERA (CriptoTerminalBridge sigue siendo de solo       |
//| lectura). Cada orden la pide una persona desde el panel, con      |
//| confirmacion, y aca se valida de nuevo antes de mandarla:         |
//|   - solo la cuenta de InpCuenta (en 0 no opera nada);             |
//|   - la orden tiene que ser para esta misma cuenta;                |
//|   - ordenes con mas de InpVencimientoSeg segundos se descartan:   |
//|     si el terminal se cuelga, no quedan ordenes viejas;           |
//|   - cada id se ejecuta una sola vez, tambien entre reinicios;     |
//|   - volumen dentro del minimo, maximo y paso del simbolo, y de    |
//|     InpLoteMax;                                                   |
//|   - SL y TP del lado correcto, y SL obligatorio si se pide.       |
//|                                                                  |
//| Protocolo (dentro de MQL5\Files\cripto-terminal\operador):        |
//|   entrada\<id>.txt   la orden, una clave=valor por linea          |
//|   salida\<id>.json   el resultado                                 |
//|   estado.json        si esta vivo y habilitado, cada segundo      |
//+------------------------------------------------------------------+
#property copyright "Terminal Cripto"
#property version   "1.00"

#include <Trade\Trade.mqh>

input long   InpCuenta         = 0;        // login habilitado para operar (0 = no opera)
input double InpLoteMax        = 5.0;      // volumen maximo por orden
input bool   InpSlObligatorio  = true;     // toda apertura necesita stop loss
input int    InpVencimientoSeg = 15;       // ordenes mas viejas que esto se descartan
input int    InpDesvioPuntos   = 50;       // deslizamiento permitido a mercado, en puntos
input int    InpMagic          = 770100;   // marca de lo que se abre desde el terminal
input string InpCarpeta        = "cripto-terminal\\operador"; // dentro de MQL5\Files

#define GV_VIVO "CriptoTerminalOperador.vivo"

CTrade   trade;
string   g_hechas[];          // ids ya procesados
bool     g_activo = false;
datetime g_ultimoEstado = 0;

//--- utilidades ---------------------------------------------------------

string JEscapar(const string s)
  {
   string out = "";
   for(int i = 0; i < StringLen(s); i++)
     {
      ushort ch = StringGetCharacter(s, i);
      if(ch == '"' || ch == '\\') out += "\\" + ShortToString(ch);
      else if(ch < 32)            out += " ";
      else                        out += ShortToString(ch);
     }
   return out;
  }

// Escribe a un temporal y lo renombra: el terminal nunca lee medio archivo.
void EscribirJson(const string ruta, const string json)
  {
   string tmp = ruta + ".tmp";
   int h = FileOpen(tmp, FILE_WRITE | FILE_TXT | FILE_ANSI | FILE_SHARE_READ);
   if(h == INVALID_HANDLE) { Print("Operador: no se pudo escribir ", tmp, " error ", GetLastError()); return; }
   FileWriteString(h, json);
   FileClose(h);
   FileMove(tmp, 0, ruta, FILE_REWRITE);
  }

//--- ids ya procesados (se recuerdan entre reinicios) --------------------

string RutaHechas() { return InpCarpeta + "\\hechas.txt"; }

void CargarHechas()
  {
   ArrayResize(g_hechas, 0);
   int h = FileOpen(RutaHechas(), FILE_READ | FILE_TXT | FILE_ANSI | FILE_SHARE_READ);
   if(h == INVALID_HANDLE) return;
   while(!FileIsEnding(h))
     {
      string id = FileReadString(h);
      StringTrimLeft(id); StringTrimRight(id);
      if(id == "") continue;
      int n = ArraySize(g_hechas);
      ArrayResize(g_hechas, n + 1);
      g_hechas[n] = id;
     }
   FileClose(h);
   // Alcanza con los ultimos 500: las ordenes vencen a los segundos.
   if(ArraySize(g_hechas) > 500)
     {
      string ultimos[];
      ArrayCopy(ultimos, g_hechas, 0, ArraySize(g_hechas) - 500, 500);
      ArrayCopy(g_hechas, ultimos);
      ArrayResize(g_hechas, 500);
      int w = FileOpen(RutaHechas(), FILE_WRITE | FILE_TXT | FILE_ANSI);
      if(w != INVALID_HANDLE)
        {
         for(int i = 0; i < ArraySize(g_hechas); i++) FileWriteString(w, g_hechas[i] + "\r\n");
         FileClose(w);
        }
     }
  }

bool YaHecha(const string id)
  {
   for(int i = ArraySize(g_hechas) - 1; i >= 0; i--)
      if(g_hechas[i] == id) return true;
   return false;
  }

void Marcar(const string id)
  {
   int n = ArraySize(g_hechas);
   ArrayResize(g_hechas, n + 1);
   g_hechas[n] = id;
   int h = FileOpen(RutaHechas(), FILE_READ | FILE_WRITE | FILE_TXT | FILE_ANSI | FILE_SHARE_READ);
   if(h == INVALID_HANDLE) return;
   FileSeek(h, 0, SEEK_END);
   FileWriteString(h, id + "\r\n");
   FileClose(h);
  }

//--- estado -------------------------------------------------------------

// Si se puede operar y, si no, por que.
bool Habilitado(string &motivo)
  {
   long login = AccountInfoInteger(ACCOUNT_LOGIN);
   if(InpCuenta == 0) { motivo = "El EA tiene InpCuenta en 0: poné tu login en sus propiedades para habilitarlo"; return false; }
   if(login != InpCuenta) { motivo = "La cuenta " + IntegerToString(login) + " no es la habilitada en el EA (" + IntegerToString(InpCuenta) + ")"; return false; }
   if(!TerminalInfoInteger(TERMINAL_CONNECTED)) { motivo = "MT5 no está conectado al servidor"; return false; }
   if(!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED)) { motivo = "Algo Trading está apagado en MT5 (botón de la barra)"; return false; }
   if(!MQLInfoInteger(MQL_TRADE_ALLOWED)) { motivo = "El EA no tiene permitido operar: tildá 'Permitir trading algorítmico' en sus propiedades"; return false; }
   if(!AccountInfoInteger(ACCOUNT_TRADE_ALLOWED)) { motivo = "La cuenta no permite operar"; return false; }
   motivo = "";
   return true;
  }

void EscribirEstado()
  {
   string motivo;
   bool ok = Habilitado(motivo);
   string json = "{";
   json += "\"version\":1,";
   json += "\"vivo_ms\":" + IntegerToString((long)TimeGMT() * 1000) + ",";
   json += "\"cuenta\":" + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)) + ",";
   json += "\"habilitado\":" + (ok ? "true" : "false") + ",";
   json += "\"motivo\":\"" + JEscapar(motivo) + "\",";
   json += "\"sl_obligatorio\":" + (InpSlObligatorio ? "true" : "false") + ",";
   json += "\"lote_max\":" + DoubleToString(InpLoteMax, 2) + ",";
   json += "\"vencimiento_seg\":" + IntegerToString(InpVencimientoSeg) + ",";
   json += "\"magic\":" + IntegerToString(InpMagic);
   json += "}";
   EscribirJson(InpCarpeta + "\\estado.json", json);
  }

//--- respuesta ----------------------------------------------------------

void Responder(const string id, const bool ok, const uint retcode, const string mensaje,
               const ulong ticket = 0, const double precio = 0.0, const double volumen = 0.0)
  {
   string json = "{";
   json += "\"id\":\"" + JEscapar(id) + "\",";
   json += "\"ok\":" + (ok ? "true" : "false") + ",";
   json += "\"retcode\":" + IntegerToString(retcode) + ",";
   json += "\"mensaje\":\"" + JEscapar(mensaje) + "\",";
   json += "\"ticket\":" + IntegerToString((long)ticket) + ",";
   json += "\"precio\":" + DoubleToString(precio, 8) + ",";
   json += "\"volumen\":" + DoubleToString(volumen, 8) + ",";
   json += "\"hora_ms\":" + IntegerToString((long)TimeGMT() * 1000);
   json += "}";
   EscribirJson(InpCarpeta + "\\salida\\" + id + ".json", json);
   Print("Operador: ", id, ok ? " OK " : " RECHAZADA ", mensaje);
  }

void ResponderTrade(const string id, const bool enviado, const string que)
  {
   uint rc = trade.ResultRetcode();
   bool ok = enviado && (rc == TRADE_RETCODE_DONE || rc == TRADE_RETCODE_PLACED || rc == TRADE_RETCODE_DONE_PARTIAL);
   string msg = ok ? que : que + ": " + trade.ResultRetcodeDescription();
   Responder(id, ok, rc, msg, trade.ResultOrder(), trade.ResultPrice(), trade.ResultVolume());
  }

//--- lectura de la orden ------------------------------------------------

string g_claves[], g_valores[];

bool Leer(const string ruta)
  {
   ArrayResize(g_claves, 0);
   ArrayResize(g_valores, 0);
   int h = FileOpen(ruta, FILE_READ | FILE_TXT | FILE_ANSI | FILE_SHARE_READ);
   if(h == INVALID_HANDLE) return false;
   while(!FileIsEnding(h))
     {
      string linea = FileReadString(h);
      int i = StringFind(linea, "=");
      if(i <= 0) continue;
      int n = ArraySize(g_claves);
      ArrayResize(g_claves, n + 1);
      ArrayResize(g_valores, n + 1);
      g_claves[n] = StringSubstr(linea, 0, i);
      g_valores[n] = StringSubstr(linea, i + 1);
      StringTrimLeft(g_valores[n]);
      StringTrimRight(g_valores[n]);
     }
   FileClose(h);
   return true;
  }

string V(const string clave)
  {
   for(int i = 0; i < ArraySize(g_claves); i++)
      if(g_claves[i] == clave) return g_valores[i];
   return "";
  }

double D(const string clave) { return StringToDouble(V(clave)); }

//--- acciones -----------------------------------------------------------

void Preparar(const string sym)
  {
   trade.SetExpertMagicNumber(InpMagic);
   trade.SetDeviationInPoints(InpDesvioPuntos);
   trade.SetTypeFillingBySymbol(sym);
   trade.SetAsyncMode(false);
  }

double AlTick(const string sym, const double p)
  {
   if(p <= 0) return 0.0;
   double tick = SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_SIZE);
   int dig = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   double x = tick > 0 ? MathRound(p / tick) * tick : p;
   return NormalizeDouble(x, dig);
  }

void Abrir(const string id)
  {
   string sym = V("symbol");
   if(sym == "" || !SymbolSelect(sym, true)) { Responder(id, false, 0, "Símbolo desconocido: " + sym); return; }
   bool compra = V("lado") == "buy";
   if(!compra && V("lado") != "sell") { Responder(id, false, 0, "Lado inválido"); return; }
   string tipo = V("tipo");
   double vol = D("volumen");
   double vmin = SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN), vmax = SymbolInfoDouble(sym, SYMBOL_VOLUME_MAX);
   double paso = SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP);
   if(vol < vmin - 1e-9 || vol > vmax + 1e-9)
     { Responder(id, false, 0, "Volumen fuera de rango (" + DoubleToString(vmin, 2) + " a " + DoubleToString(vmax, 2) + ")"); return; }
   if(vol > InpLoteMax + 1e-9) { Responder(id, false, 0, "Volumen mayor que InpLoteMax (" + DoubleToString(InpLoteMax, 2) + ")"); return; }
   if(paso > 0 && MathAbs(vol / paso - MathRound(vol / paso)) > 1e-6) { Responder(id, false, 0, "El volumen no respeta el paso de " + DoubleToString(paso, 2)); return; }

   double ask = SymbolInfoDouble(sym, SYMBOL_ASK), bid = SymbolInfoDouble(sym, SYMBOL_BID);
   double ref;
   if(tipo == "mercado") ref = compra ? ask : bid;
   else if(tipo == "limite")
     {
      ref = AlTick(sym, D("precio"));
      if(ref <= 0) { Responder(id, false, 0, "Falta el precio de la orden límite"); return; }
      if(compra ? ref >= ask : ref <= bid) { Responder(id, false, 0, "Una compra límite va debajo del precio y una venta límite, arriba"); return; }
     }
   else { Responder(id, false, 0, "Tipo de orden inválido: " + tipo); return; }

   double sl = AlTick(sym, D("sl")), tp = AlTick(sym, D("tp"));
   if(InpSlObligatorio && sl <= 0) { Responder(id, false, 0, "Falta el stop loss (InpSlObligatorio)"); return; }
   if(sl > 0 && (compra ? sl >= ref : sl <= ref)) { Responder(id, false, 0, "El stop loss tiene que quedar del otro lado de la entrada"); return; }
   if(tp > 0 && (compra ? tp <= ref : tp >= ref)) { Responder(id, false, 0, "El take profit tiene que quedar del lado de la ganancia"); return; }
   double minimo = SymbolInfoInteger(sym, SYMBOL_TRADE_STOPS_LEVEL) * SymbolInfoDouble(sym, SYMBOL_POINT);
   if(sl > 0 && MathAbs(ref - sl) < minimo) { Responder(id, false, 0, "El stop loss está más cerca que el mínimo del broker"); return; }
   if(tp > 0 && MathAbs(ref - tp) < minimo) { Responder(id, false, 0, "El take profit está más cerca que el mínimo del broker"); return; }

   Preparar(sym);
   string com = "terminal";
   bool enviado;
   if(tipo == "mercado") enviado = compra ? trade.Buy(vol, sym, 0.0, sl, tp, com) : trade.Sell(vol, sym, 0.0, sl, tp, com);
   else enviado = compra ? trade.BuyLimit(vol, ref, sym, sl, tp, ORDER_TIME_GTC, 0, com) : trade.SellLimit(vol, ref, sym, sl, tp, ORDER_TIME_GTC, 0, com);
   ResponderTrade(id, enviado, tipo == "mercado" ? (compra ? "Compra abierta" : "Venta abierta") : (compra ? "Compra límite puesta" : "Venta límite puesta"));
  }

void Cerrar(const string id)
  {
   ulong ticket = (ulong)StringToInteger(V("ticket"));
   if(!PositionSelectByTicket(ticket)) { Responder(id, false, 0, "No existe la posición " + IntegerToString((long)ticket)); return; }
   string sym = PositionGetString(POSITION_SYMBOL);
   double total = PositionGetDouble(POSITION_VOLUME);
   double vol = D("volumen");
   // La posición puede haber cambiado desde la validación del servidor.
   // Solo cero pide explícitamente cerrar todo; un parcial excesivo se rechaza.
   if(!MathIsValidNumber(vol) || vol < 0 || vol > total + 1e-9)
     { Responder(id, false, 0, "El volumen a cerrar no es válido o supera el volumen actual; revisa la posición"); return; }
   if(vol > 0 && vol < total - 1e-9)
     {
      double paso = SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP);
      double minimo = SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN);
      if(vol < minimo - 1e-9 || total - vol < minimo - 1e-9 ||
         (paso > 0 && MathAbs(vol / paso - MathRound(vol / paso)) > 1e-6))
        { Responder(id, false, 0, "El cierre parcial no respeta el mínimo o el paso de volumen del símbolo"); return; }
     }
   Preparar(sym);
   bool parcial = vol > 0 && vol < total - 1e-9;
   bool enviado = parcial ? trade.PositionClosePartial(ticket, vol) : trade.PositionClose(ticket);
   ResponderTrade(id, enviado, parcial ? "Cierre parcial hecho" : "Posición cerrada");
  }

void Modificar(const string id)
  {
   ulong ticket = (ulong)StringToInteger(V("ticket"));
   if(PositionSelectByTicket(ticket))
     {
      string sym = PositionGetString(POSITION_SYMBOL);
      double sl = AlTick(sym, D("sl")), tp = AlTick(sym, D("tp"));
      if(InpSlObligatorio && sl <= 0) { Responder(id, false, 0, "No se puede quitar el stop loss (InpSlObligatorio)"); return; }
      Preparar(sym);
      ResponderTrade(id, trade.PositionModify(ticket, sl, tp), "SL y TP actualizados");
      return;
     }
   if(OrderSelect(ticket))
     {
      string sym = OrderGetString(ORDER_SYMBOL);
      double precio = D("precio") > 0 ? AlTick(sym, D("precio")) : OrderGetDouble(ORDER_PRICE_OPEN);
      double sl = AlTick(sym, D("sl")), tp = AlTick(sym, D("tp"));
      if(InpSlObligatorio && sl <= 0) { Responder(id, false, 0, "No se puede quitar el stop loss (InpSlObligatorio)"); return; }
      Preparar(sym);
      ResponderTrade(id, trade.OrderModify(ticket, precio, sl, tp, ORDER_TIME_GTC, 0), "Orden pendiente actualizada");
      return;
     }
   Responder(id, false, 0, "No existe la posición ni la orden " + IntegerToString((long)ticket));
  }

void Cancelar(const string id)
  {
   ulong ticket = (ulong)StringToInteger(V("ticket"));
   if(!OrderSelect(ticket)) { Responder(id, false, 0, "No existe la orden pendiente " + IntegerToString((long)ticket)); return; }
   Preparar(OrderGetString(ORDER_SYMBOL));
   ResponderTrade(id, trade.OrderDelete(ticket), "Orden cancelada");
  }

//--- ciclo --------------------------------------------------------------

void Procesar(const string nombre)
  {
   // Se reclama moviendola: si hubiera otro operador corriendo, solo uno la toma.
   string origen = InpCarpeta + "\\entrada\\" + nombre;
   string tomada = InpCarpeta + "\\proceso\\" + nombre;
   if(!FileMove(origen, 0, tomada, FILE_REWRITE)) return;
   bool leida = Leer(tomada);
   FileDelete(tomada);
   if(!leida) return;
   string id = V("id");
   if(id == "") return;
   if(YaHecha(id)) { Responder(id, false, 0, "Orden repetida: ya se procesó"); return; }
   Marcar(id);

   string motivo;
   if(!Habilitado(motivo)) { Responder(id, false, 0, motivo); return; }
   if(StringToInteger(V("cuenta")) != AccountInfoInteger(ACCOUNT_LOGIN)) { Responder(id, false, 0, "La orden es para otra cuenta"); return; }
   long ahora = (long)TimeGMT() * 1000;
   long creada = StringToInteger(V("creado"));
   if(ahora - creada > (long)InpVencimientoSeg * 1000 + 1000 || creada - ahora > 5000)
     { Responder(id, false, 0, "Orden vencida: llegó tarde a MT5 y no se ejecutó"); return; }

   string accion = V("accion");
   if(accion == "abrir") Abrir(id);
   else if(accion == "cerrar") Cerrar(id);
   else if(accion == "modificar") Modificar(id);
   else if(accion == "cancelar") Cancelar(id);
   else Responder(id, false, 0, "Acción desconocida: " + accion);
  }

void Revisar()
  {
   string nombre;
   long busqueda = FileFindFirst(InpCarpeta + "\\entrada\\*.txt", nombre);
   if(busqueda == INVALID_HANDLE) return;
   string nombres[];
   do
     {
      int n = ArraySize(nombres);
      ArrayResize(nombres, n + 1);
      nombres[n] = nombre;
     }
   while(FileFindNext(busqueda, nombre));
   FileFindClose(busqueda);
   for(int i = 0; i < ArraySize(nombres); i++) Procesar(nombres[i]);
  }

int OnInit()
  {
   // Un solo operador por terminal: dos tomarian las mismas ordenes.
   if(GlobalVariableCheck(GV_VIVO) && (long)TimeLocal() - (long)GlobalVariableGet(GV_VIVO) < 5)
     {
      Print("Operador: ya hay otro operador activo en otro gráfico; este se retira.");
      return INIT_FAILED;
     }
   g_activo = true;
   GlobalVariableSet(GV_VIVO, (double)TimeLocal());
   FolderCreate("cripto-terminal");
   FolderCreate(InpCarpeta);
   FolderCreate(InpCarpeta + "\\entrada");
   FolderCreate(InpCarpeta + "\\proceso");
   FolderCreate(InpCarpeta + "\\salida");
   CargarHechas();
   EventSetMillisecondTimer(250);
   EscribirEstado();
   string motivo;
   Print("Operador Terminal Cripto activo · ", Habilitado(motivo) ? "habilitado" : "NO habilitado: " + motivo);
   return INIT_SUCCEEDED;
  }

void OnDeinit(const int reason)
  {
   EventKillTimer();
   if(g_activo) GlobalVariableDel(GV_VIVO);
  }

void OnTimer()
  {
   GlobalVariableSet(GV_VIVO, (double)TimeLocal());
   Revisar();
   if(TimeLocal() != g_ultimoEstado)
     {
      g_ultimoEstado = TimeLocal();
      EscribirEstado();
     }
  }
