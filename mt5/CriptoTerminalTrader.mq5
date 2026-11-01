//+------------------------------------------------------------------+
//| CriptoTerminalTrader.mq5                                         |
//| Ejecutor de ordenes del Terminal Cripto.                          |
//|                                                                  |
//| Lee MQL5\Files\cripto-terminal\ordenes.txt y ejecuta lo que ahi   |
//| se pide. A diferencia de CriptoTerminalBridge, ESTE SI OPERA.     |
//|                                                                  |
//| Cada orden se valida de nuevo aca antes de mandarse. No es        |
//| redundancia ociosa: si el proceso que escribe el archivo se       |
//| cuelga, escribe mal o queda viejo, este EA tiene que poder        |
//| negarse solo. Un ejecutor que confia en lo que le mandan es un    |
//| ejecutor roto.                                                    |
//|                                                                  |
//| Guardas, en orden de importancia:                                 |
//|   - solo cuentas DEMO, salvo que se desactive a mano;             |
//|   - solo el login configurado;                                    |
//|   - toda orden necesita S/L, del lado correcto;                   |
//|   - riesgo por operacion recalculado aca, con tope propio;        |
//|   - lote maximo, posiciones maximas, simbolos permitidos;         |
//|   - ordenes vencidas se descartan;                                |
//|   - cada id se ejecuta UNA vez, y se recuerda entre reinicios.    |
//+------------------------------------------------------------------+
#property copyright "Terminal Cripto"
#property version   "1.00"

#include <Trade\Trade.mqh>

input string InpArchivo        = "cripto-terminal\\ordenes.txt";   // ordenes a leer
input string InpEjecutadas     = "cripto-terminal\\ejecutadas.txt"; // ids ya usados
input int    InpRefrescoMs     = 2000;      // cada cuanto revisa
input bool   InpSoloDemo       = true;      // SOLO cuentas demo
input long   InpCuenta         = 1514711885; // login habilitado (0 = ninguno, rechaza todo)
input double InpLoteMax        = 0.50;      // lote maximo por orden
input double InpMaxMargenPct   = 30.0;      // % del equity que inmoviliza UNA orden
input double InpMaxExposicionPct = 60.0;    // % del equity inmovilizado en total
input int    InpPosicionesMax  = 2;         // posiciones simultaneas de este EA
input double InpRiesgoMaxPct   = 1.0;       // % del equity por operacion, tope propio
input string InpSimbolos       = "ADAUSD,XLMUSD,XRPUSD,BTCUSD,ETHUSD"; // permitidos
input int    InpMagic          = 770001;    // marca de este EA
input int    InpDesvioPuntos   = 50;        // slippage permitido
input string InpEstado         = "cripto-terminal\\trader-estado.txt"; // publica su estado aca

CTrade   trade;
string   g_ejecutadas[];
uint     g_ultimo_aviso = 0;

// Cerrojo de instancia unica. Dos copias del EA leyendo el mismo archivo pueden
// pasar las dos el chequeo de "ya ejecutada" antes de que cualquiera lo marque,
// y abrir dos posiciones con una sola senal.
//
// Es un cerrojo CON LATIDO, no una simple marca de presencia: la instancia viva
// reescribe la hora en cada ciclo, y otra solo se aborta si ese latido es
// reciente. Una marca sin latido se queda huerfana cuando el EA se saca de golpe
// o se recompila sin pasar por OnDeinit, y despues ninguna instancia puede
// arrancar mas — hay que reiniciar el terminal para destrabarlo.
const string CERROJO = "CriptoTerminalTrader_instancia";
const int    CERROJO_VENCE = 30;      // segundos sin latido para darlo por muerto
bool g_tengo_cerrojo = false;

bool TomarCerrojo(string &porque)
  {
   if(GlobalVariableCheck(CERROJO))
     {
      long ultimo = (long)GlobalVariableGet(CERROJO);
      long edad = (long)TimeGMT() - ultimo;
      if(edad >= 0 && edad < CERROJO_VENCE)
        {
         porque = StringFormat("ya hay otra instancia viva (latido hace %d s)", (int)edad);
         return false;
        }
      Print("Trader: cerrojo huerfano de hace ", (int)edad, " s, se toma");
     }
   GlobalVariableSet(CERROJO, (double)TimeGMT());
   return true;
  }

void LatirCerrojo()
  {
   if(g_tengo_cerrojo)
      GlobalVariableSet(CERROJO, (double)TimeGMT());
  }

//+------------------------------------------------------------------+
//| utilidades                                                        |
//+------------------------------------------------------------------+
bool YaEjecutada(const string id)
  {
   for(int i = 0; i < ArraySize(g_ejecutadas); i++)
      if(g_ejecutadas[i] == id)
         return true;
   return false;
  }

void RecordarEjecutada(const string id)
  {
   int n = ArraySize(g_ejecutadas);
   ArrayResize(g_ejecutadas, n + 1);
   g_ejecutadas[n] = id;
   // Se persiste en el acto: un reinicio no puede repetir una orden.
   int h = FileOpen(InpEjecutadas, FILE_READ | FILE_WRITE | FILE_TXT | FILE_ANSI | FILE_SHARE_READ);
   if(h == INVALID_HANDLE)
     {
      Print("Trader: no se pudo abrir ", InpEjecutadas, " error ", GetLastError());
      return;
     }
   FileSeek(h, 0, SEEK_END);
   FileWriteString(h, id + "\r\n");
   FileClose(h);
  }

void CargarEjecutadas()
  {
   ArrayResize(g_ejecutadas, 0);
   if(!FileIsExist(InpEjecutadas))
      return;
   int h = FileOpen(InpEjecutadas, FILE_READ | FILE_TXT | FILE_ANSI | FILE_SHARE_READ | FILE_SHARE_WRITE);
   if(h == INVALID_HANDLE)
      return;
   while(!FileIsEnding(h))
     {
      string linea = FileReadString(h);
      StringTrimLeft(linea);
      StringTrimRight(linea);
      if(StringLen(linea) > 0)
        {
         int n = ArraySize(g_ejecutadas);
         ArrayResize(g_ejecutadas, n + 1);
         g_ejecutadas[n] = linea;
        }
     }
   FileClose(h);
   Print("Trader: ", ArraySize(g_ejecutadas), " ordenes ya ejecutadas en memoria");
  }

bool SimboloPermitido(const string sym)
  {
   string lista[];
   StringSplit(InpSimbolos, StringGetCharacter(",", 0), lista);
   for(int i = 0; i < ArraySize(lista); i++)
     {
      string s = lista[i];
      StringTrimLeft(s);
      StringTrimRight(s);
      if(s == sym)
         return true;
     }
   return false;
  }

int PosicionesPropias()
  {
   int n = 0;
   for(int i = 0; i < PositionsTotal(); i++)
     {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0 || !PositionSelectByTicket(ticket))
         continue;
      if(PositionGetInteger(POSITION_MAGIC) == InpMagic)
         n++;
     }
   return n;
  }

int PendientesPropias()
  {
   int n = 0;
   for(int i = 0; i < OrdersTotal(); i++)
     {
      ulong ticket = OrderGetTicket(i);
      if(ticket == 0 || !OrderSelect(ticket))
         continue;
      if(OrderGetInteger(ORDER_MAGIC) == InpMagic)
         n++;
     }
   return n;
  }

// El cupo lo ocupan las dos: una limite esperando ya es riesgo comprometido,
// aunque todavia no haya posicion.
int CupoUsado() { return PosicionesPropias() + PendientesPropias(); }

// Una pendiente identica ya colocada no se repite. El id de la orden viaja en
// el comentario, que es lo unico que sobrevive del lado del broker.
bool YaHayPendiente(const string sym, const double precio, const int digits)
  {
   for(int i = 0; i < OrdersTotal(); i++)
     {
      ulong ticket = OrderGetTicket(i);
      if(ticket == 0 || !OrderSelect(ticket))
         continue;
      if(OrderGetInteger(ORDER_MAGIC) != InpMagic)
         continue;
      if(OrderGetString(ORDER_SYMBOL) != sym)
         continue;
      if(NormalizeDouble(OrderGetDouble(ORDER_PRICE_OPEN), digits) ==
         NormalizeDouble(precio, digits))
         return true;
     }
   return false;
  }

//+------------------------------------------------------------------+
//| estado propio                                                     |
//|                                                                  |
//| Publica si esta activo y, si no lo esta, por que. Depender de la  |
//| pestana Expertos obliga a tener la pantalla delante para          |
//| diagnosticar; asi el estado se puede leer desde afuera.           |
//+------------------------------------------------------------------+
void PublicarEstado(const bool activo, const string motivo)
  {
   int h = FileOpen(InpEstado, FILE_WRITE | FILE_TXT | FILE_ANSI | FILE_SHARE_READ);
   if(h == INVALID_HANDLE)
      return;
   string linea = StringFormat("V1|%d|%d|%I64d|%d|%d|%d|%s",
                               (int)TimeGMT(),
                               activo ? 1 : 0,
                               AccountInfoInteger(ACCOUNT_LOGIN),
                               (AccountInfoInteger(ACCOUNT_TRADE_MODE) == ACCOUNT_TRADE_MODE_DEMO) ? 1 : 0,
                               PosicionesPropias(),
                               ArraySize(g_ejecutadas),
                               motivo);
   FileWriteString(h, linea + "\r\n");
   FileClose(h);
  }

//+------------------------------------------------------------------+
//| la cuenta habilitada                                              |
//+------------------------------------------------------------------+
bool CuentaHabilitada(string &porque)
  {
   if(InpSoloDemo && AccountInfoInteger(ACCOUNT_TRADE_MODE) != ACCOUNT_TRADE_MODE_DEMO)
     {
      porque = "la cuenta no es DEMO y InpSoloDemo esta activo";
      return false;
     }
   if(InpCuenta <= 0)
     {
      porque = "InpCuenta esta en 0: no hay cuenta habilitada";
      return false;
     }
   if(AccountInfoInteger(ACCOUNT_LOGIN) != InpCuenta)
     {
      porque = StringFormat("login %I64d no es el habilitado (%I64d)",
                            AccountInfoInteger(ACCOUNT_LOGIN), InpCuenta);
      return false;
     }
   if(!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED))
     {
      porque = "el terminal tiene el trading algoritmico desactivado";
      return false;
     }
   if(!MQLInfoInteger(MQL_TRADE_ALLOWED))
     {
      porque = "este EA no tiene permiso de comercio algoritmico";
      return false;
     }
   return true;
  }

//+------------------------------------------------------------------+
//| validacion y envio de una orden                                   |
//+------------------------------------------------------------------+
bool Validar(const string sym, const bool compra, const bool limite,
             const double precio_limite, double &volumen,
             const double sl, const double riesgo_declarado, string &porque)
  {
   if(!SimboloPermitido(sym))
     { porque = "simbolo no permitido: " + sym; return false; }
   if(!SymbolSelect(sym, true))
     { porque = "no se pudo seleccionar " + sym; return false; }

   // --- el S/L es obligatorio. Sin el no hay riesgo acotado y no se manda nada.
   if(sl <= 0.0)
     { porque = "la orden no trae S/L"; return false; }

   double ask = SymbolInfoDouble(sym, SYMBOL_ASK);
   double bid = SymbolInfoDouble(sym, SYMBOL_BID);
   double mercado = compra ? ask : bid;
   if(mercado <= 0.0)
     { porque = "sin precio para " + sym; return false; }

   // En una limite el riesgo se mide desde el precio de la orden, no desde el
   // de mercado: es ahi donde se va a llenar.
   double precio = limite ? precio_limite : mercado;
   if(limite)
     {
      if(precio <= 0.0)
        { porque = "limite sin precio"; return false; }
      // Una compra limite tiene que estar POR DEBAJO del mercado y una venta
      // limite por encima; si no, el broker la rechaza o se llena al instante.
      if((compra && precio >= mercado) || (!compra && precio <= mercado))
        { porque = StringFormat("limite %.8g del lado equivocado del mercado (%.8g)",
                                precio, mercado); return false; }
      long nivel_l = SymbolInfoInteger(sym, SYMBOL_TRADE_STOPS_LEVEL);
      double punto_l = SymbolInfoDouble(sym, SYMBOL_POINT);
      if(nivel_l > 0 && MathAbs(mercado - precio) < nivel_l * punto_l)
        { porque = "la limite esta mas cerca que el minimo del broker"; return false; }
     }

   if((compra && sl >= precio) || (!compra && sl <= precio))
     { porque = "el S/L esta del lado equivocado del precio"; return false; }

   // --- distancia minima que exige el broker
   long nivel = SymbolInfoInteger(sym, SYMBOL_TRADE_STOPS_LEVEL);
   double punto = SymbolInfoDouble(sym, SYMBOL_POINT);
   if(nivel > 0 && MathAbs(precio - sl) < nivel * punto)
     { porque = "el S/L esta mas cerca que el minimo del broker"; return false; }

   // --- volumen dentro de lo que el simbolo y este EA permiten
   double paso = SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP);
   double vmin = SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN);
   double vmax = SymbolInfoDouble(sym, SYMBOL_VOLUME_MAX);
   if(paso > 0)
      volumen = MathFloor(volumen / paso + 1e-9) * paso;
   if(volumen < vmin)
     { porque = "volumen por debajo del minimo"; return false; }
   if(volumen > MathMin(vmax, InpLoteMax))
     { porque = StringFormat("volumen %.4f pasa el tope (%.4f)",
                             volumen, MathMin(vmax, InpLoteMax)); return false; }

   // --- riesgo recalculado ACA, no el que vino en el archivo
   double tick_size  = SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_SIZE);
   double tick_value = SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_VALUE);
   double por_punto  = (tick_size > 0 && tick_value > 0)
                       ? tick_value / tick_size
                       : SymbolInfoDouble(sym, SYMBOL_TRADE_CONTRACT_SIZE);
   double riesgo = MathAbs(precio - sl) * por_punto * volumen;
   double equity = AccountInfoDouble(ACCOUNT_EQUITY);
   if(equity <= 0)
     { porque = "sin equity"; return false; }
   double pct = riesgo / equity * 100.0;
   if(pct > InpRiesgoMaxPct)
     { porque = StringFormat("riesgo %.2f%% pasa el tope de %.2f%%", pct, InpRiesgoMaxPct);
       return false; }
   // Si lo que declara el archivo difiere mucho de lo calculado aca, algo esta
   // mal en alguno de los dos lados: no se opera a ciegas.
   if(riesgo_declarado > 0 && MathAbs(riesgo - riesgo_declarado) > riesgo_declarado * 0.30)
     { porque = StringFormat("el riesgo declarado (%.2f) no coincide con el real (%.2f)",
                             riesgo_declarado, riesgo); return false; }

   // --- margen
   // Con margen 1:1 el margen ES el nocional, y en scalping un stop corto pide
   // un tamano enorme para el mismo riesgo en dolares: el riesgo puede salir
   // perfecto y la posicion ser media cuenta igual. Un tope por LOTE no alcanza
   // para frenarlo, porque el lote que equivale a medio capital cambia con el
   // precio de cada simbolo. El tope util es por margen.
   double margen = 0.0;
   if(!OrderCalcMargin(compra ? ORDER_TYPE_BUY : ORDER_TYPE_SELL, sym, volumen, precio, margen))
     { porque = "no se pudo calcular el margen"; return false; }
   if(margen > AccountInfoDouble(ACCOUNT_MARGIN_FREE))
     { porque = "margen insuficiente"; return false; }
   if(InpMaxMargenPct > 0 && margen > equity * InpMaxMargenPct / 100.0)
     { porque = StringFormat("inmoviliza %.1f%% del equity (tope %.1f%%)",
                             margen / equity * 100.0, InpMaxMargenPct); return false; }
   if(InpMaxExposicionPct > 0)
     {
      double usado = AccountInfoDouble(ACCOUNT_MARGIN);
      if(usado + margen > equity * InpMaxExposicionPct / 100.0)
        { porque = StringFormat("la exposicion quedaria en %.1f%% (tope %.1f%%)",
                                (usado + margen) / equity * 100.0, InpMaxExposicionPct);
          return false; }
     }

   return true;
  }

//+------------------------------------------------------------------+
//| cierre de una posicion propia                                     |
//|                                                                  |
//| Solo cierra lo que abrio este EA (mismo magic). Una posicion      |
//| abierta a mano no se toca nunca, aunque el archivo lo pida.       |
//+------------------------------------------------------------------+
void CerrarPosicion(const string id, const ulong ticket, const string motivo)
  {
   if(!PositionSelectByTicket(ticket))
     {
      Print("Trader: CIERRE ", id, " ticket ", ticket, " ya no existe");
      RecordarEjecutada(id);
      return;
     }
   if(PositionGetInteger(POSITION_MAGIC) != InpMagic)
     {
      Print("Trader: CIERRE RECHAZADO ", id, " ticket ", ticket,
            " no es de este EA (magic ", PositionGetInteger(POSITION_MAGIC), ")");
      RecordarEjecutada(id);
      return;
     }

   string sym = PositionGetString(POSITION_SYMBOL);
   trade.SetExpertMagicNumber(InpMagic);
   trade.SetDeviationInPoints(InpDesvioPuntos);
   trade.SetTypeFillingBySymbol(sym);

   if(trade.PositionClose(ticket))
      Print("Trader: CERRADA ", id, " ticket ", ticket, " ", sym, " | ", motivo);
   else
      Print("Trader: FALLO CIERRE ", id, " ticket ", ticket, " retcode ",
            trade.ResultRetcode(), " ", trade.ResultRetcodeDescription());
   RecordarEjecutada(id);
  }

void Ejecutar(const string id, const string sym, const bool compra,
              const bool limite, const double precio_limite,
              double volumen, const double sl, const double tp,
              const double riesgo, const datetime vence, const string motivo)
  {
   string porque = "";
   if(!Validar(sym, compra, limite, precio_limite, volumen, sl, riesgo, porque))
     {
      Print("Trader: RECHAZADA ", id, " (", sym, ") -> ", porque);
      RecordarEjecutada(id);       // no se reintenta: la decision ya se tomo
      return;
     }

   int digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   double sl_n = NormalizeDouble(sl, digits);
   double tp_n = (tp > 0.0) ? NormalizeDouble(tp, digits) : 0.0;

   trade.SetExpertMagicNumber(InpMagic);
   trade.SetDeviationInPoints(InpDesvioPuntos);
   trade.SetTypeFillingBySymbol(sym);

   bool ok = false;
   string etiqueta = StringSubstr(id, 0, 8) + " " + StringSubstr(motivo, 0, 20);
   if(limite)
     {
      double lim_n = NormalizeDouble(precio_limite, digits);
      if(YaHayPendiente(sym, lim_n, digits))
        {
         Print("Trader: ya hay una limite de ", sym, " en ", lim_n, ", no se duplica");
         RecordarEjecutada(id);
         return;
        }
      // Con vencimiento: una limite olvidada se llena semanas despues, cuando
      // el setup que la justificaba ya no existe.
      ENUM_ORDER_TYPE_TIME modo = (vence > 0) ? ORDER_TIME_SPECIFIED : ORDER_TIME_GTC;
      ok = compra
           ? trade.BuyLimit(volumen, lim_n, sym, sl_n, tp_n, modo, vence, etiqueta)
           : trade.SellLimit(volumen, lim_n, sym, sl_n, tp_n, modo, vence, etiqueta);
      if(ok)
         Print("Trader: PENDIENTE ", id, " ", (compra ? "BUY_LIMIT " : "SELL_LIMIT "),
               volumen, " ", sym, " en ", lim_n, " S/L ", sl_n, " T/P ", tp_n,
               " vence ", TimeToString(vence), " | ", motivo);
     }
   else
     {
      ok = compra
           ? trade.Buy(volumen, sym, 0.0, sl_n, tp_n, etiqueta)
           : trade.Sell(volumen, sym, 0.0, sl_n, tp_n, etiqueta);
      if(ok)
         Print("Trader: EJECUTADA ", id, " ", (compra ? "BUY " : "SELL "), volumen, " ",
               sym, " S/L ", sl_n, " T/P ", tp_n, " | ", motivo);
     }

   if(!ok)
      Print("Trader: FALLO ", id, " ", sym, " retcode ", trade.ResultRetcode(),
            " ", trade.ResultRetcodeDescription());

   // En los dos casos se marca: un fallo no se reintenta solo, porque el precio
   // ya se movio y la orden dejo de ser la que se penso.
   RecordarEjecutada(id);
  }

//+------------------------------------------------------------------+
//| lectura del archivo                                               |
//+------------------------------------------------------------------+
void Revisar()
  {
   string porque = "";
   if(!CuentaHabilitada(porque))
     {
      PublicarEstado(false, porque);
      if(GetTickCount() - g_ultimo_aviso > 60000)
        {
         Print("Trader: INACTIVO -> ", porque);
         g_ultimo_aviso = GetTickCount();
        }
      return;
     }
   PublicarEstado(true, "activo");
   if(!FileIsExist(InpArchivo))
      return;

   int h = FileOpen(InpArchivo, FILE_READ | FILE_TXT | FILE_ANSI | FILE_SHARE_READ | FILE_SHARE_WRITE);
   if(h == INVALID_HANDLE)
      return;

   bool cabecera_ok = false;
   while(!FileIsEnding(h))
     {
      string linea = FileReadString(h);
      StringTrimLeft(linea);
      StringTrimRight(linea);
      if(StringLen(linea) == 0)
         continue;

      string campos[];
      int n = StringSplit(linea, StringGetCharacter("|", 0), campos);

      if(campos[0] == "V2")
        {
         // V2|<login>|<ts>  -- el archivo tiene que ser para ESTA cuenta
         if(n >= 2 && StringToInteger(campos[1]) == AccountInfoInteger(ACCOUNT_LOGIN))
            cabecera_ok = true;
         else
            Print("Trader: el archivo no es para esta cuenta, se ignora");
         continue;
        }
      if(campos[0] == "V1")
        {
         Print("Trader: archivo en formato viejo (V1), se ignora");
         continue;
        }
      if(!cabecera_ok || campos[0] != "O" || n < 12)
         continue;

      // O|id|expira|symbol|tipo|volumen|precio|sl|tp|riesgo|expira_orden|motivo
      string id       = campos[1];
      long   expira   = StringToInteger(campos[2]);
      string sym      = campos[3];
      string tipo     = campos[4];
      bool   compra   = (tipo == "buy" || tipo == "buy_limit");
      bool   limite   = (tipo == "buy_limit" || tipo == "sell_limit");
      double volumen  = StringToDouble(campos[5]);
      double precio_l = StringToDouble(campos[6]);
      double sl       = StringToDouble(campos[7]);
      double tp       = StringToDouble(campos[8]);
      double riesgo   = StringToDouble(campos[9]);
      datetime vence  = (datetime)StringToInteger(campos[10]);
      string motivo   = campos[11];

      if(YaEjecutada(id))
         continue;
      if(tipo != "close" && tipo != "buy" && tipo != "sell" && tipo != "buy_limit" && tipo != "sell_limit")
        {
         Print("Trader: tipo de orden invalido ", tipo, " en ", id, "; se descarta");
         RecordarEjecutada(id);
         continue;
        }
      if(expira <= 0 || TimeGMT() > (datetime)expira)
        {
         Print("Trader: VENCIDA ", id, " (", sym, "), se descarta");
         RecordarEjecutada(id);
         continue;
        }
      // Un cierre no ocupa cupo ni necesita las validaciones de apertura.
      if(tipo == "close")
        {
         CerrarPosicion(id, (ulong)precio_l, motivo);
         continue;
        }

      if(CupoUsado() >= InpPosicionesMax)
        {
         Print("Trader: cupo lleno (", CupoUsado(), " entre posiciones y pendientes), no se abre ", id);
         continue;      // no se marca: cuando se libere lugar puede valer
        }
      Ejecutar(id, sym, compra, limite, precio_l, volumen, sl, tp, riesgo, vence, motivo);
     }
   FileClose(h);
  }

//+------------------------------------------------------------------+
//| ciclo de vida                                                     |
//+------------------------------------------------------------------+
int OnInit()
  {
   // GlobalVariableTemp devuelve false si la variable ya existe: eso hace de
   // cerrojo sin necesidad de nada mas.
   string trabado = "";
   if(!TomarCerrojo(trabado))
     {
      Print("Trader: ABORTADO -> ", trabado, ". Dejalo en UN solo grafico.");
      return INIT_FAILED;
     }
   g_tengo_cerrojo = true;

   CargarEjecutadas();
   string porque = "";
   if(CuentaHabilitada(porque))
      Print("Trader: ACTIVO en la cuenta ", AccountInfoInteger(ACCOUNT_LOGIN),
            " (", (AccountInfoInteger(ACCOUNT_TRADE_MODE) == ACCOUNT_TRADE_MODE_DEMO
                   ? "DEMO" : "REAL"), ")");
   else
      Print("Trader: INACTIVO -> ", porque);

   EventSetMillisecondTimer(InpRefrescoMs < 500 ? 500 : InpRefrescoMs);
   return INIT_SUCCEEDED;
  }

void OnDeinit(const int reason)
  {
   EventKillTimer();
   // Solo suelta el cerrojo el que lo tomo, para que una instancia abortada no
   // se lo saque a la que si esta trabajando.
   if(g_tengo_cerrojo)
      GlobalVariableDel(CERROJO);
  }

void OnTimer()
  {
   LatirCerrojo();
   Revisar();
  }
