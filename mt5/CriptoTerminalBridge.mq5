//+------------------------------------------------------------------+
//| CriptoTerminalBridge.mq5                                         |
//| Puente de solo lectura entre MetaTrader 5 y el Terminal Cripto.   |
//|                                                                  |
//| Escribe el estado de la cuenta, las posiciones abiertas y los     |
//| datos de cada simbolo en un JSON dentro de MQL5\Files, para que   |
//| el terminal lo lea y cruce la operacion real contra la zona.      |
//|                                                                  |
//| v2: exporta tambien las velas del broker. La historia (M1 a MN1)  |
//| va en MQL5\Files\cripto-terminal\velas, un archivo por simbolo y  |
//| temporalidad; las dos ultimas velas de cada temporalidad van en   |
//| estado.json cada segundo, junto con el desfase horario del        |
//| servidor para pasarlas a UTC.                                     |
//|                                                                  |
//| v5: exporta el historial de la cuenta (cierres, con su motivo, y  |
//| depositos) en cripto-terminal\historial.json, para el diario de   |
//| operaciones y los limites de perdida de la cuenta de fondeo.      |
//|                                                                  |
//| v9: exporta el calendario economico de MT5 (el de MetaQuotes, con |
//| el dato real apenas sale) en cripto-terminal\calendario.json: el  |
//| terminal completa con el los datos que el calendario de FTMO      |
//| todavia no publico.                                               |
//|                                                                  |
//| NO opera: no manda ordenes, no toca posiciones. Solo lee.         |
//+------------------------------------------------------------------+
#property copyright "Terminal Cripto"
#property version   "9.00"

input string InpArchivo      = "cripto-terminal\\estado.json"; // ruta dentro de MQL5\Files
input int    InpRefrescoMs   = 1000;                           // cada cuanto reescribe
input string InpSimbolos     = "BTCUSD,XAUUSD,XAGUSD,US30.cash,US100.cash,US500.cash"; // simbolos a exportar (ademas de los que tengan posicion)
input string InpVelasCarpeta = "cripto-terminal\\velas";       // historia de velas, dentro de MQL5\Files
input string InpVelasTF      = "M1,M5,M15,M30,H1,H4,D1,W1,MN1";     // temporalidades que se exportan
input int    InpVelasN       = 1000;                           // velas por archivo de historia
input int    InpVelasCadaSeg = 10;                             // cada cuanto se revisa la historia
input string InpHistorial    = "cripto-terminal\\historial.json"; // historial de la cuenta, dentro de MQL5\Files
input int    InpHistorialDias = 400;                           // dias de historial que se exportan
input string InpCalendario   = "cripto-terminal\\calendario.json"; // calendario economico de MT5, dentro de MQL5\Files
input int    InpCalendarioSeg = 10;                            // cada cuanto se revisa el calendario

//--- utilidades de JSON -------------------------------------------------

string JEscapar(const string s)
  {
   string out = "";
   for(int i = 0; i < StringLen(s); i++)
     {
      ushort ch = StringGetCharacter(s, i);
      if(ch == '"' || ch == '\\')      out += "\\" + ShortToString(ch);
      else if(ch == '\n')              out += "\\n";
      else if(ch == '\r')              out += "\\r";
      else if(ch == '\t')              out += "\\t";
      else if(ch < 32)                 out += " ";
      else                             out += ShortToString(ch);
     }
   return out;
  }

string JTexto(const string clave, const string valor) { return "\"" + clave + "\":\"" + JEscapar(valor) + "\""; }
string JNum(const string clave, const double valor, const int dig = 8) { return "\"" + clave + "\":" + DoubleToString(valor, dig); }
string JEnt(const string clave, const long valor) { return "\"" + clave + "\":" + IntegerToString(valor); }

//--- bloques del estado -------------------------------------------------

string BloqueCuenta()
  {
   string s = "{";
   s += JEnt("login", AccountInfoInteger(ACCOUNT_LOGIN)) + ",";
   s += JTexto("server", AccountInfoString(ACCOUNT_SERVER)) + ",";
   s += JTexto("company", AccountInfoString(ACCOUNT_COMPANY)) + ",";
   s += JTexto("currency", AccountInfoString(ACCOUNT_CURRENCY)) + ",";
   s += JEnt("leverage", AccountInfoInteger(ACCOUNT_LEVERAGE)) + ",";
   s += JTexto("mode", AccountInfoInteger(ACCOUNT_MARGIN_MODE) == ACCOUNT_MARGIN_MODE_RETAIL_HEDGING ? "hedging" : "netting") + ",";
   s += JNum("balance", AccountInfoDouble(ACCOUNT_BALANCE), 2) + ",";
   s += JNum("equity", AccountInfoDouble(ACCOUNT_EQUITY), 2) + ",";
   s += JNum("profit", AccountInfoDouble(ACCOUNT_PROFIT), 2) + ",";
   s += JNum("margin", AccountInfoDouble(ACCOUNT_MARGIN), 2) + ",";
   s += JNum("margin_free", AccountInfoDouble(ACCOUNT_MARGIN_FREE), 2) + ",";
   s += JNum("margin_level", AccountInfoDouble(ACCOUNT_MARGIN_LEVEL), 2);
   s += "}";
   return s;
  }

// Sesiones de trading de la semana: [dia (0 = domingo), desde, hasta], en segundos
// desde las 00:00 del servidor (hasta llega a 86400: las 24:00).
string Sesiones(const string sym)
  {
   string s = "[";
   bool primera = true;
   for(int d = 0; d < 7; d++)
      for(uint i = 0; i < 10; i++)
        {
         datetime desde, hasta;
         if(!SymbolInfoSessionTrade(sym, (ENUM_DAY_OF_WEEK)d, i, desde, hasta))
            break;
         long a = (long)desde % 86400, b = (long)hasta;
         b = (b > 0 && b % 86400 == 0) ? 86400 : b % 86400;
         s += (primera ? "" : ",") + "[" + IntegerToString(d) + "," + IntegerToString(a) + "," + IntegerToString(b) + "]";
         primera = false;
        }
   return s + "]";
  }

string BloqueSimbolo(const string sym)
  {
   if(!SymbolSelect(sym, true))
      return "";
   string s = "{";
   s += JTexto("symbol", sym) + ",";
   s += JEnt("digits", (long)SymbolInfoInteger(sym, SYMBOL_DIGITS)) + ",";
   s += JNum("point", SymbolInfoDouble(sym, SYMBOL_POINT)) + ",";
   s += JNum("bid", SymbolInfoDouble(sym, SYMBOL_BID)) + ",";
   s += JNum("ask", SymbolInfoDouble(sym, SYMBOL_ASK)) + ",";
   s += JEnt("time", (long)SymbolInfoInteger(sym, SYMBOL_TIME)) + ",";   // ultima cotizacion, hora del servidor
   s += JEnt("spread", (long)SymbolInfoInteger(sym, SYMBOL_SPREAD)) + ",";
   s += JNum("contract_size", SymbolInfoDouble(sym, SYMBOL_TRADE_CONTRACT_SIZE), 2) + ",";
   s += JNum("tick_size", SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_SIZE)) + ",";
   s += JNum("tick_value", SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_VALUE), 6) + ",";
   s += JNum("volume_min", SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN), 8) + ",";
   s += JNum("volume_step", SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP), 8) + ",";
   s += JNum("volume_max", SymbolInfoDouble(sym, SYMBOL_VOLUME_MAX), 8) + ",";
   s += JEnt("stops_level", (long)SymbolInfoInteger(sym, SYMBOL_TRADE_STOPS_LEVEL)) + ",";
   s += JNum("swap_long", SymbolInfoDouble(sym, SYMBOL_SWAP_LONG), 4) + ",";
   s += JNum("swap_short", SymbolInfoDouble(sym, SYMBOL_SWAP_SHORT), 4) + ",";

   // Margen de 1 lote. OrderCalcMargin solo calcula: no crea ni envia ninguna
   // orden. En cripto el margen suele ser el nocional completo, aunque la cuenta
   // declare un leverage alto, y es lo que en la practica limita el lotaje.
   double margen = 0.0;
   double ask = SymbolInfoDouble(sym, SYMBOL_ASK);
   if(!OrderCalcMargin(ORDER_TYPE_BUY, sym, 1.0, ask, margen))
      margen = 0.0;
   s += JNum("margin_per_lot", margen, 2) + ",";
   // Si se puede operar y en que horario (hora del servidor): la terminal avisa
   // antes del cierre, porque con el mercado cerrado no se cancela ni se modifica nada.
   s += JEnt("trade_mode", (long)SymbolInfoInteger(sym, SYMBOL_TRADE_MODE)) + ",";
   s += "\"sesiones\":" + Sesiones(sym);
   s += "}";
   return s;
  }

string BloquePosiciones(string &simbolos[])
  {
   string s = "[";
   int total = PositionsTotal();
   bool primera = true;
   for(int i = 0; i < total; i++)
     {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0 || !PositionSelectByTicket(ticket))
         continue;
      string sym = PositionGetString(POSITION_SYMBOL);

      // el simbolo de cada posicion tambien va en la lista de cotizaciones
      bool esta = false;
      for(int k = 0; k < ArraySize(simbolos); k++)
         if(simbolos[k] == sym) { esta = true; break; }
      if(!esta)
        {
         ArrayResize(simbolos, ArraySize(simbolos) + 1);
         simbolos[ArraySize(simbolos) - 1] = sym;
        }

      if(!primera) s += ",";
      primera = false;
      s += "{";
      s += JEnt("ticket", (long)ticket) + ",";
      s += JTexto("symbol", sym) + ",";
      s += JTexto("type", PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY ? "buy" : "sell") + ",";
      s += JNum("volume", PositionGetDouble(POSITION_VOLUME), 8) + ",";
      s += JNum("price_open", PositionGetDouble(POSITION_PRICE_OPEN)) + ",";
      s += JNum("price_current", PositionGetDouble(POSITION_PRICE_CURRENT)) + ",";
      s += JNum("sl", PositionGetDouble(POSITION_SL)) + ",";
      s += JNum("tp", PositionGetDouble(POSITION_TP)) + ",";
      s += JNum("profit", PositionGetDouble(POSITION_PROFIT), 2) + ",";
      s += JNum("swap", PositionGetDouble(POSITION_SWAP), 2) + ",";
      s += JEnt("time", (long)PositionGetInteger(POSITION_TIME)) + ",";
      s += JEnt("magic", PositionGetInteger(POSITION_MAGIC)) + ",";
      s += JTexto("comment", PositionGetString(POSITION_COMMENT));
      s += "}";
     }
   s += "]";
   return s;
  }

// Ordenes pendientes (limite, stop). Solo se leen.
string BloqueOrdenes()
  {
   string s = "[";
   bool primera = true;
   for(int i = 0; i < OrdersTotal(); i++)
     {
      ulong ticket = OrderGetTicket(i);
      if(ticket == 0 || !OrderSelect(ticket)) continue;
      ENUM_ORDER_TYPE tipo = (ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE);
      string t = tipo == ORDER_TYPE_BUY_LIMIT ? "buy_limit" : tipo == ORDER_TYPE_SELL_LIMIT ? "sell_limit"
               : tipo == ORDER_TYPE_BUY_STOP ? "buy_stop" : tipo == ORDER_TYPE_SELL_STOP ? "sell_stop" : "otra";
      if(!primera) s += ",";
      primera = false;
      s += "{";
      s += JEnt("ticket", (long)ticket) + ",";
      s += JTexto("symbol", OrderGetString(ORDER_SYMBOL)) + ",";
      s += JTexto("type", t) + ",";
      s += JNum("volume", OrderGetDouble(ORDER_VOLUME_CURRENT), 8) + ",";
      s += JNum("price_open", OrderGetDouble(ORDER_PRICE_OPEN)) + ",";
      s += JNum("sl", OrderGetDouble(ORDER_SL)) + ",";
      s += JNum("tp", OrderGetDouble(ORDER_TP)) + ",";
      s += JEnt("time", (long)OrderGetInteger(ORDER_TIME_SETUP)) + ",";
      s += JEnt("magic", OrderGetInteger(ORDER_MAGIC));
      s += "}";
     }
   return s + "]";
  }

//--- velas del broker ---------------------------------------------------

string   g_simbolos[];          // los de InpSimbolos mas los que tengan posicion
string   g_tfs[];               // temporalidades a exportar, ya separadas
datetime g_ultimaRevision = 0;  // ultima vez que se reviso la historia

// Lo ultimo que se escribio de cada historia: se reescribe solo si aparecio
// una vela nueva o llego mas historia del servidor.
string   g_hClave[];
datetime g_hUltima[];
int      g_hCuantas[];

// Desfase del servidor respecto de GMT, en segundos y redondeado a 15 minutos.
// Las velas de MT5 vienen en hora del servidor: el terminal lo resta para
// pasarlas a UTC.
long Desfase()
  {
   long d = (long)TimeTradeServer() - (long)TimeGMT();
   return (long)MathRound(d / 900.0) * 900;
  }

ENUM_TIMEFRAMES Temporalidad(const string tf)
  {
   if(tf == "M1")  return PERIOD_M1;
   if(tf == "M5")  return PERIOD_M5;
   if(tf == "M15") return PERIOD_M15;
   if(tf == "M30") return PERIOD_M30;
   if(tf == "H1")  return PERIOD_H1;
   if(tf == "H4")  return PERIOD_H4;
   if(tf == "D1")  return PERIOD_D1;
   if(tf == "W1")  return PERIOD_W1;
   if(tf == "MN1") return PERIOD_MN1;
   return PERIOD_CURRENT;
  }

// [hora del servidor, apertura, maximo, minimo, cierre, volumen de ticks]
string Vela(const MqlRates &r, const int dig)
  {
   return "[" + IntegerToString((long)r.time) + "," + DoubleToString(r.open, dig) + ","
          + DoubleToString(r.high, dig) + "," + DoubleToString(r.low, dig) + ","
          + DoubleToString(r.close, dig) + "," + IntegerToString(r.tick_volume) + "]";
  }

// Las dos ultimas velas de cada temporalidad de un simbolo. Solo de las series
// que ya estan listas: pedir una que el servidor todavia esta mandando puede
// frenar el EA, y de eso se encarga la revision de la historia.
string VelasVivas(const string sym)
  {
   int dig = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   string s = "{";
   bool primera = true;
   for(int j = 0; j < ArraySize(g_tfs); j++)
     {
      ENUM_TIMEFRAMES tf = Temporalidad(g_tfs[j]);
      if(tf == PERIOD_CURRENT || SeriesInfoInteger(sym, tf, SERIES_SYNCHRONIZED) == 0)
         continue;
      MqlRates r[];
      int n = CopyRates(sym, tf, 0, 2, r);
      if(n <= 0)
         continue;
      if(!primera) s += ",";
      primera = false;
      s += "\"" + g_tfs[j] + "\":[";
      for(int i = 0; i < n; i++)
         s += (i > 0 ? "," : "") + Vela(r[i], dig);
      s += "]";
     }
   return s + "}";
  }

// La historia de un simbolo en una temporalidad, vela por vela (sin armar un
// texto gigante en memoria), a un temporal que despues se renombra.
//
// Solo lo que MT5 ya tiene armado: pedir mas velas de las que hay lo obliga a
// bajar anos de velas de 1 minuto (con las que arma todas las temporalidades) y
// el EA queda frenado hasta que termina. Una serie sin armar se pide con una
// sola vela, que la pone a armarse, y se exporta en la proxima revision.
void EscribirHistoria(const string sym, const string tfTxt)
  {
   ENUM_TIMEFRAMES tf = Temporalidad(tfTxt);
   if(tf == PERIOD_CURRENT)
      return;
   if(SeriesInfoInteger(sym, tf, SERIES_SYNCHRONIZED) == 0)
     {
      datetime t[];
      CopyTime(sym, tf, 0, 1, t);
      return;
     }
   int pedir = MathMin(InpVelasN, Bars(sym, tf));
   if(pedir <= 0)
      return;
   MqlRates r[];
   int n = CopyRates(sym, tf, 0, pedir, r);
   if(n <= 0)
      return;

   string clave = sym + "_" + tfTxt;
   int k = -1;
   for(int i = 0; i < ArraySize(g_hClave); i++)
      if(g_hClave[i] == clave) { k = i; break; }
   if(k < 0)
     {
      k = ArraySize(g_hClave);
      ArrayResize(g_hClave, k + 1);
      ArrayResize(g_hUltima, k + 1);
      ArrayResize(g_hCuantas, k + 1);
      g_hClave[k] = clave;
      g_hUltima[k] = 0;
      g_hCuantas[k] = 0;
     }
   if(g_hUltima[k] == r[n - 1].time && g_hCuantas[k] == n)
      return;   // nada nuevo: la vela abierta va en estado.json

   int dig = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   string ruta = InpVelasCarpeta + "\\" + clave + ".json";
   string tmp = ruta + ".tmp";
   int h = FileOpen(tmp, FILE_WRITE | FILE_TXT | FILE_ANSI | FILE_SHARE_READ);
   if(h == INVALID_HANDLE)
     {
      Print("Bridge: no se pudo abrir ", tmp, " error ", GetLastError());
      return;
     }
   FileWriteString(h, "{" + JTexto("symbol", sym) + "," + JTexto("tf", tfTxt) + ","
                   + JEnt("gmt_offset", Desfase()) + "," + JEnt("written_ms", (long)TimeGMT() * 1000) + ",\"bars\":[");
   for(int i = 0; i < n; i++)
      FileWriteString(h, (i > 0 ? "," : "") + Vela(r[i], dig));
   FileWriteString(h, "]}");
   FileClose(h);
   if(!FileMove(tmp, 0, ruta, FILE_REWRITE))
     {
      Print("Bridge: no se pudo renombrar a ", ruta, " error ", GetLastError());
      return;
     }
   g_hUltima[k] = r[n - 1].time;
   g_hCuantas[k] = n;
  }

// Historia larga a pedido (para probar el modelo con la cotizacion del broker):
// la terminal deja en historia.txt lineas "SIMBOLO,TF,VELAS" y el puente las
// exporta a velas\SIMBOLO_TF_largo.json. Cuando estan todas, borra el pedido.
// Solo lee: no toca ordenes ni graficos.
void HistoriaLarga()
  {
   string ruta = Carpeta() + "\\historia.txt";
   if(!FileIsExist(ruta))
      return;
   int h = FileOpen(ruta, FILE_READ | FILE_TXT | FILE_ANSI | FILE_SHARE_READ | FILE_SHARE_WRITE);
   if(h == INVALID_HANDLE)
      return;
   string pedidos[];
   while(!FileIsEnding(h))
     {
      string x = FileReadString(h);
      StringTrimLeft(x);
      StringTrimRight(x);
      if(x == "") continue;
      int n = ArraySize(pedidos);
      ArrayResize(pedidos, n + 1);
      pedidos[n] = x;
     }
   FileClose(h);
   bool todos = true;
   for(int i = 0; i < ArraySize(pedidos); i++)
     {
      string c[];
      if(StringSplit(pedidos[i], StringGetCharacter(",", 0), c) != 3) continue;
      string sym = c[0], tfTxt = c[1];
      int cuantas = (int)StringToInteger(c[2]);
      ENUM_TIMEFRAMES tf = Temporalidad(tfTxt);
      if(tf == PERIOD_CURRENT || cuantas <= 0 || !SymbolSelect(sym, true)) continue;
      MqlRates r[];
      int n = CopyRates(sym, tf, 0, cuantas, r);
      // Con menos de lo pedido, el servidor todavia esta mandando historia: otra vuelta.
      if(n <= 0 || (n < cuantas && SeriesInfoInteger(sym, tf, SERIES_SYNCHRONIZED) == 0)) { todos = false; continue; }
      int dig = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
      string destino = InpVelasCarpeta + "\\" + sym + "_" + tfTxt + "_largo.json", tmp = destino + ".tmp";
      int f = FileOpen(tmp, FILE_WRITE | FILE_TXT | FILE_ANSI | FILE_SHARE_READ);
      if(f == INVALID_HANDLE) { todos = false; continue; }
      FileWriteString(f, "{" + JTexto("symbol", sym) + "," + JTexto("tf", tfTxt) + ","
                      + JEnt("gmt_offset", Desfase()) + "," + JEnt("written_ms", (long)TimeGMT() * 1000) + ",\"bars\":[");
      for(int k = 0; k < n; k++)
         FileWriteString(f, (k > 0 ? "," : "") + Vela(r[k], dig));
      FileWriteString(f, "]}");
      FileClose(f);
      FileMove(tmp, 0, destino, FILE_REWRITE);
      Print("Bridge: historia larga de ", sym, " ", tfTxt, ": ", n, " velas");
     }
   if(todos)
      FileDelete(ruta);
  }

void RevisarHistoria()
  {
   for(int i = 0; i < ArraySize(g_simbolos); i++)
     {
      if(g_simbolos[i] == "" || !SymbolSelect(g_simbolos[i], true))
         continue;
      for(int j = 0; j < ArraySize(g_tfs); j++)
         EscribirHistoria(g_simbolos[i], g_tfs[j]);
     }
  }

//--- historial de la cuenta --------------------------------------------

// Cada operacion de la cuenta en los ultimos InpHistorialDias: entradas y cierres
// (con el motivo: SL, TP, a mano, stop out), depositos y retiros. Solo lee el
// historial; se reescribe cuando aparece algo nuevo.
int      g_histCuantos = -1;
long     g_histUltimo = -1;
datetime g_histRevision = 0;

string TipoDeal(const long t)
  {
   switch((int)t)
     {
      case DEAL_TYPE_BUY:        return "buy";
      case DEAL_TYPE_SELL:       return "sell";
      case DEAL_TYPE_BALANCE:    return "balance";
      case DEAL_TYPE_CREDIT:     return "credit";
      case DEAL_TYPE_CHARGE:     return "charge";
      case DEAL_TYPE_CORRECTION: return "correction";
      case DEAL_TYPE_BONUS:      return "bonus";
      case DEAL_TYPE_COMMISSION: return "commission";
      case DEAL_TYPE_INTEREST:   return "interest";
     }
   return "other";
  }

string EntradaDeal(const long e)
  {
   switch((int)e)
     {
      case DEAL_ENTRY_IN:     return "in";
      case DEAL_ENTRY_OUT:    return "out";
      case DEAL_ENTRY_INOUT:  return "inout";
      case DEAL_ENTRY_OUT_BY: return "out_by";
     }
   return "";
  }

string MotivoDeal(const long r)
  {
   switch((int)r)
     {
      case DEAL_REASON_CLIENT:   return "client";
      case DEAL_REASON_MOBILE:   return "mobile";
      case DEAL_REASON_WEB:      return "web";
      case DEAL_REASON_EXPERT:   return "expert";
      case DEAL_REASON_SL:       return "sl";
      case DEAL_REASON_TP:       return "tp";
      case DEAL_REASON_SO:       return "so";
      case DEAL_REASON_ROLLOVER: return "rollover";
      case DEAL_REASON_VMARGIN:  return "vmargin";
      case DEAL_REASON_SPLIT:    return "split";
     }
   return "other";
  }

void EscribirHistorial()
  {
   datetime desde = TimeCurrent() - (datetime)((long)InpHistorialDias * 86400);
   if(!HistorySelect(desde, TimeCurrent() + 86400))
      return;
   int total = HistoryDealsTotal();
   long ultimo = 0;
   if(total > 0)
      ultimo = HistoryDealGetInteger(HistoryDealGetTicket(total - 1), DEAL_TIME_MSC);
   if(total == g_histCuantos && ultimo == g_histUltimo)
      return;

   string tmp = InpHistorial + ".tmp";
   int h = FileOpen(tmp, FILE_WRITE | FILE_TXT | FILE_ANSI | FILE_SHARE_READ);
   if(h == INVALID_HANDLE)
     {
      Print("Bridge: no se pudo abrir ", tmp, " error ", GetLastError());
      return;
     }
   FileWriteString(h, "{" + JEnt("written_ms", (long)TimeGMT() * 1000) + "," + JEnt("gmt_offset", Desfase()) + ","
                   + JEnt("login", AccountInfoInteger(ACCOUNT_LOGIN)) + "," + JTexto("currency", AccountInfoString(ACCOUNT_CURRENCY)) + ","
                   + JEnt("desde", (long)desde) + ",\"deals\":[");
   bool primera = true;
   for(int i = 0; i < total; i++)
     {
      ulong t = HistoryDealGetTicket(i);
      if(t == 0)
         continue;
      string s = primera ? "{" : ",{";
      primera = false;
      s += JEnt("ticket", (long)t) + ",";
      s += JEnt("order", HistoryDealGetInteger(t, DEAL_ORDER)) + ",";
      s += JEnt("position", HistoryDealGetInteger(t, DEAL_POSITION_ID)) + ",";
      s += JEnt("time", HistoryDealGetInteger(t, DEAL_TIME)) + ",";        // hora del servidor
      s += JEnt("time_msc", HistoryDealGetInteger(t, DEAL_TIME_MSC)) + ",";
      s += JTexto("type", TipoDeal(HistoryDealGetInteger(t, DEAL_TYPE))) + ",";
      s += JTexto("entry", EntradaDeal(HistoryDealGetInteger(t, DEAL_ENTRY))) + ",";
      s += JTexto("reason", MotivoDeal(HistoryDealGetInteger(t, DEAL_REASON))) + ",";
      s += JTexto("symbol", HistoryDealGetString(t, DEAL_SYMBOL)) + ",";
      s += JNum("volume", HistoryDealGetDouble(t, DEAL_VOLUME), 8) + ",";
      s += JNum("price", HistoryDealGetDouble(t, DEAL_PRICE)) + ",";
      s += JNum("sl", HistoryDealGetDouble(t, DEAL_SL)) + ",";
      s += JNum("tp", HistoryDealGetDouble(t, DEAL_TP)) + ",";
      s += JNum("profit", HistoryDealGetDouble(t, DEAL_PROFIT), 2) + ",";
      s += JNum("commission", HistoryDealGetDouble(t, DEAL_COMMISSION), 2) + ",";
      s += JNum("swap", HistoryDealGetDouble(t, DEAL_SWAP), 2) + ",";
      s += JNum("fee", HistoryDealGetDouble(t, DEAL_FEE), 2) + ",";
      s += JEnt("magic", HistoryDealGetInteger(t, DEAL_MAGIC)) + ",";
      s += JTexto("comment", HistoryDealGetString(t, DEAL_COMMENT));
      FileWriteString(h, s + "}");
     }
   FileWriteString(h, "]}");
   FileClose(h);
   if(!FileMove(tmp, 0, InpHistorial, FILE_REWRITE))
     {
      Print("Bridge: no se pudo renombrar a ", InpHistorial, " error ", GetLastError());
      return;
     }
   g_histCuantos = total;
   g_histUltimo = ultimo;
  }

//--- buscador de la terminal --------------------------------------------

// La carpeta de los archivos de la terminal (la de InpArchivo).
string Carpeta()
  {
   int corte = StringFind(InpArchivo, "\\");
   return corte > 0 ? StringSubstr(InpArchivo, 0, corte) : "cripto-terminal";
  }

// Los simbolos que pide la terminal (favoritos y el que se mira), uno por linea en
// pedidos.txt: se exportan como los de InpSimbolos. Solo se leen, no se opera nada.
void AgregarPedidos(string &simbolos[])
  {
   int h = FileOpen(Carpeta() + "\\pedidos.txt", FILE_READ | FILE_TXT | FILE_ANSI | FILE_SHARE_READ | FILE_SHARE_WRITE);
   if(h == INVALID_HANDLE)
      return;
   while(!FileIsEnding(h))
     {
      string s = FileReadString(h);
      StringTrimLeft(s);
      StringTrimRight(s);
      if(s == "" || !SymbolInfoInteger(s, SYMBOL_EXIST))
         continue;
      bool ya = false;
      for(int i = 0; i < ArraySize(simbolos) && !ya; i++)
         ya = StringCompare(simbolos[i], s, false) == 0;
      if(ya)
         continue;
      int n = ArraySize(simbolos);
      ArrayResize(simbolos, n + 1);
      simbolos[n] = s;
     }
   FileClose(h);
  }

// Todos los simbolos del broker (nombre, descripcion y grupo), cada 10 minutos:
// asi la terminal sabe como se llama cada mercado en FTMO.
datetime g_catalogo = 0;

void EscribirCatalogo()
  {
   if(g_catalogo != 0 && (long)(TimeLocal() - g_catalogo) < 600)
      return;
   g_catalogo = TimeLocal();
   string ruta = Carpeta() + "\\catalogo.json", tmp = ruta + ".tmp";
   int h = FileOpen(tmp, FILE_WRITE | FILE_TXT | FILE_ANSI | FILE_SHARE_READ);
   if(h == INVALID_HANDLE)
      return;
   FileWriteString(h, "{" + JEnt("written_ms", (long)TimeGMT() * 1000) + ",\"simbolos\":[");
   int n = SymbolsTotal(false);
   for(int i = 0; i < n; i++)
     {
      string s = SymbolName(i, false);
      FileWriteString(h, (i > 0 ? "," : "") + "{" + JTexto("symbol", s) + "," + JTexto("descripcion", SymbolInfoString(s, SYMBOL_DESCRIPTION))
                      + "," + JTexto("ruta", SymbolInfoString(s, SYMBOL_PATH)) + "," + JEnt("trade_mode", SymbolInfoInteger(s, SYMBOL_TRADE_MODE)) + "}");
     }
   FileWriteString(h, "]}");
   FileClose(h);
   FileMove(tmp, 0, ruta, FILE_REWRITE);
  }

//--- escritura ----------------------------------------------------------

void Escribir()
  {
   string simbolos[];
   StringSplit(InpSimbolos, StringGetCharacter(",", 0), simbolos);
   for(int i = 0; i < ArraySize(simbolos); i++)
     {
      StringTrimLeft(simbolos[i]);
      StringTrimRight(simbolos[i]);
     }
   AgregarPedidos(simbolos);
   EscribirCatalogo();

   string posiciones = BloquePosiciones(simbolos);   // agrega los simbolos con posicion
   ArrayCopy(g_simbolos, simbolos);
   ArrayResize(g_simbolos, ArraySize(simbolos));

   string cotizaciones = "[";
   string velas = "{";
   bool primera = true;
   for(int i = 0; i < ArraySize(simbolos); i++)
     {
      if(simbolos[i] == "") continue;
      string bloque = BloqueSimbolo(simbolos[i]);
      if(bloque == "") continue;
      if(!primera) { cotizaciones += ","; velas += ","; }
      primera = false;
      cotizaciones += bloque;
      velas += "\"" + JEscapar(simbolos[i]) + "\":" + VelasVivas(simbolos[i]);
     }
   cotizaciones += "]";
   velas += "}";

   string json = "{";
   json += JEnt("written_ms", (long)TimeGMT() * 1000) + ",";
   json += JEnt("server_time", (long)TimeCurrent()) + ",";
   json += JEnt("bridge_version", 9) + ",";
   json += JEnt("gmt_offset", Desfase()) + ",";
   json += JTexto("terminal", TerminalInfoString(TERMINAL_NAME)) + ",";
   json += JEnt("connected", TerminalInfoInteger(TERMINAL_CONNECTED)) + ",";
   json += "\"account\":" + BloqueCuenta() + ",";
   json += "\"positions\":" + posiciones + ",";
   json += "\"orders\":" + BloqueOrdenes() + ",";
   json += "\"symbols\":" + cotizaciones + ",";
   json += "\"velas\":" + velas;
   json += "}";

   // Se escribe a un temporal y se renombra: el lector nunca ve medio archivo.
   string tmp = InpArchivo + ".tmp";
   int h = FileOpen(tmp, FILE_WRITE | FILE_TXT | FILE_ANSI | FILE_SHARE_READ);
   if(h == INVALID_HANDLE)
     {
      Print("Bridge: no se pudo abrir ", tmp, " error ", GetLastError());
      return;
     }
   FileWriteString(h, json);
   FileClose(h);
   if(!FileMove(tmp, 0, InpArchivo, FILE_REWRITE))
      Print("Bridge: no se pudo renombrar a ", InpArchivo, " error ", GetLastError());
  }

//--- un solo puente por terminal ----------------------------------------

// Si MT5 abre el puente en dos graficos (el del perfil y el del arranque), el
// segundo se retira: los dos escribirian los mismos archivos.
#define GV_VIVO "CriptoTerminalBridge.vivo"
bool g_activo = false;

//--- ciclo de vida ------------------------------------------------------

int OnInit()
  {
   if(GlobalVariableCheck(GV_VIVO) && (long)TimeLocal() - (long)GlobalVariableGet(GV_VIVO) < 5)
     {
      Print("Bridge: ya hay un puente activo en otro grafico; este se retira.");
      return INIT_FAILED;
     }
   g_activo = true;
   GlobalVariableSet(GV_VIVO, (double)TimeLocal());
   string carpeta = InpArchivo;
   int corte = StringFind(carpeta, "\\");
   if(corte > 0)
      FolderCreate(StringSubstr(carpeta, 0, corte));
   FolderCreate(InpVelasCarpeta);
   StringSplit(InpVelasTF, StringGetCharacter(",", 0), g_tfs);
   for(int i = 0; i < ArraySize(g_tfs); i++)
     {
      StringTrimLeft(g_tfs[i]);
      StringTrimRight(g_tfs[i]);
      StringToUpper(g_tfs[i]);
     }
   EventSetMillisecondTimer(InpRefrescoMs < 200 ? 200 : InpRefrescoMs);
   Escribir();
   EscribirHistorial();
   Print("Bridge Terminal Cripto v9 activo -> MQL5\\Files\\", InpArchivo, ", ", InpVelasCarpeta, ", ", InpHistorial, " y ", InpCalendario);
   return INIT_SUCCEEDED;
  }

void OnDeinit(const int reason)
  {
   EventKillTimer();
   if(g_activo)
      GlobalVariableDel(GV_VIVO);
  }

//--- calendario economico ----------------------------------------------

datetime g_calRevision = 0;
ulong    g_calCambio = 0;      // el ultimo cambio del calendario ya escrito (CalendarValueLast)

// Un valor del calendario (ya dividido por un millon) con su unidad y su
// multiplicador, como lo muestra MT5: "4.00 %", "-1.9 M". Vacio si no hay.
string ValorCalendario(const bool hay, const double v, const MqlCalendarEvent &ev)
  {
   if(!hay)
      return "";
   string mult = "";
   switch(ev.multiplier)
     {
      case CALENDAR_MULTIPLIER_THOUSANDS: mult = " K"; break;
      case CALENDAR_MULTIPLIER_MILLIONS:  mult = " M"; break;
      case CALENDAR_MULTIPLIER_BILLIONS:  mult = " B"; break;
      case CALENDAR_MULTIPLIER_TRILLIONS: mult = " T"; break;
     }
   string unidad = ev.unit == CALENDAR_UNIT_PERCENT ? " %" : "";
   return DoubleToString(v, (int)ev.digits) + mult + unidad;
  }

// Los eventos de ayer a la semana que viene, con el dato real, el estimado y el
// anterior. Solo se reescribe si el calendario cambio (CalendarValueLast).
void EscribirCalendario()
  {
   MqlCalendarValue cambios[];
   ulong cambio = g_calCambio;
   int n = CalendarValueLast(cambio, cambios);
   if(g_calCambio != 0 && n <= 0)
      return;
   g_calCambio = cambio;

   datetime ahora = TimeTradeServer();
   MqlCalendarValue valores[];
   int total = CalendarValueHistory(valores, ahora - 86400, ahora + 7 * 86400);
   if(total < 0)
      return;
   string tmp = InpCalendario + ".tmp";
   int h = FileOpen(tmp, FILE_WRITE | FILE_TXT | FILE_ANSI | FILE_SHARE_READ);
   if(h == INVALID_HANDLE)
     {
      Print("Bridge: no se pudo abrir ", tmp, " error ", GetLastError());
      return;
     }
   FileWriteString(h, "{" + JEnt("written_ms", (long)TimeGMT() * 1000) + "," + JEnt("gmt_offset", Desfase()) + ",\"eventos\":[");
   bool primera = true;
   for(int i = 0; i < total; i++)
     {
      MqlCalendarEvent ev;
      MqlCalendarCountry pais;
      if(!CalendarEventById(valores[i].event_id, ev) || !CalendarCountryById(ev.country_id, pais))
         continue;
      if(ev.importance == CALENDAR_IMPORTANCE_NONE)
         continue;
      string x = primera ? "{" : ",{";
      primera = false;
      x += JEnt("time", (long)valores[i].time) + ",";       // hora del servidor
      x += JTexto("moneda", pais.currency) + ",";
      x += JTexto("nombre", ev.name) + ",";
      x += JEnt("importancia", (long)ev.importance) + ",";
      x += JTexto("actual", ValorCalendario(valores[i].HasActualValue(), valores[i].GetActualValue(), ev)) + ",";
      x += JTexto("estimado", ValorCalendario(valores[i].HasForecastValue(), valores[i].GetForecastValue(), ev)) + ",";
      x += JTexto("anterior", ValorCalendario(valores[i].HasPreviousValue(), valores[i].GetPreviousValue(), ev));
      FileWriteString(h, x + "}");
     }
   FileWriteString(h, "]}");
   FileClose(h);
   if(!FileMove(tmp, 0, InpCalendario, FILE_REWRITE))
      Print("Bridge: no se pudo renombrar a ", InpCalendario, " error ", GetLastError());
  }

// Solo por temporizador: en cripto llegan cientos de ticks por minuto y no tiene
// sentido reescribir el archivo con cada uno. La historia va despues del estado:
// si el servidor todavia esta mandando velas, CopyRates puede demorar.
void OnTimer()
  {
   GlobalVariableSet(GV_VIVO, (double)TimeLocal());
   Escribir();
   // El historial se revisa cada 2 segundos (solo se reescribe si hay algo nuevo):
   // un cierre cambia el balance y los limites del dia enseguida.
   if((long)(TimeLocal() - g_histRevision) >= 2)
     {
      g_histRevision = TimeLocal();
      EscribirHistorial();
     }
   if((long)(TimeLocal() - g_ultimaRevision) >= InpVelasCadaSeg)
     {
      g_ultimaRevision = TimeLocal();
      RevisarHistoria();
      HistoriaLarga();
     }
   // El calendario economico: el dato real de una noticia sale al segundo.
   if((long)(TimeLocal() - g_calRevision) >= InpCalendarioSeg)
     {
      g_calRevision = TimeLocal();
      EscribirCalendario();
     }
  }
