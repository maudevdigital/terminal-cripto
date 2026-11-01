//+------------------------------------------------------------------+
//| SesionesIFVG.mq5                                                 |
//| Las sesiones del mercado en el grafico de MT5, como el indicador |
//| de sesiones de TradingView: una caja por sesion (Sidney, Tokio,   |
//| Londres y Nueva York) con su maximo y su minimo. Cada sesion va  |
//| en la hora de su ciudad, con su horario de verano, y se pasa a   |
//| la hora del servidor. Solo dibuja: no opera.                     |
//+------------------------------------------------------------------+
#property copyright "Cripto Terminal (uso personal)"
#property version   "2.00"
#property indicator_chart_window
#property indicator_plots 0

input int    DiasAtras       = 30;               // Dias hacia atras
input int    HorasServidorNY = 7;                // Horas del servidor sobre Nueva York (FTMO: 7)
input bool   Relleno         = true;             // Cajas con relleno
input bool   Etiquetas       = true;             // Nombres de las sesiones
input bool   VerSidney       = true;             // Sidney
input string HorasSidney     = "07:00-16:00";    // Sidney (hora de Sidney)
input color  ColorSidney     = C'255,235,59';
input bool   VerTokio        = true;             // Tokio
input string HorasTokio      = "09:00-18:00";    // Tokio (hora de Tokio)
input color  ColorTokio      = C'233,30,99';
input bool   VerLondres      = true;             // Londres
input string HorasLondres    = "08:00-17:00";    // Londres (hora de Londres)
input color  ColorLondres    = C'33,87,243';
input bool   VerNuevaYork    = true;             // Nueva York
input string HorasNuevaYork  = "09:30-16:00";    // Nueva York (hora de NY: la bolsa)
input color  ColorNuevaYork  = C'255,93,0';

#define PREFIJO "SesIFVG_"
#define HORA    3600
#define DIA     86400

enum ZONA { SIDNEY, TOKIO, LONDRES, NUEVA_YORK };

//--- Horarios ------------------------------------------------------------

// Instante UTC de una fecha y hora (sin desfase).
datetime Fecha(const int anio, const int mes, const int dia, const int hora)
  {
   MqlDateTime d;
   ZeroMemory(d);
   d.year = anio; d.mon = mes; d.day = dia; d.hour = hora;
   return StructToTime(d);
  }

// Dia del mes del n-esimo domingo de un mes (n = -1: el ultimo).
int Domingo(const int anio, const int mes, const int n)
  {
   MqlDateTime x;
   if(n < 0)
     {
      int sig = mes == 12 ? 1 : mes + 1, a = mes == 12 ? anio + 1 : anio;
      TimeToStruct(Fecha(a, sig, 1, 0) - DIA, x);   // el ultimo dia del mes
      return x.day - x.day_of_week;
     }
   TimeToStruct(Fecha(anio, mes, 1, 0), x);
   return 1 + (7 - x.day_of_week) % 7 + 7 * (n - 1);
  }

// Horas de una ciudad sobre UTC en un instante UTC, con su horario de verano.
int Desfase(const ZONA z, const datetime utc)
  {
   MqlDateTime x;
   TimeToStruct(utc, x);
   int a = x.year;
   switch(z)
     {
      case TOKIO:
         return 9;
      case NUEVA_YORK:    // del segundo domingo de marzo al primero de noviembre (02:00 NY)
         return (utc >= Fecha(a, 3, Domingo(a, 3, 2), 7) && utc < Fecha(a, 11, Domingo(a, 11, 1), 6)) ? -4 : -5;
      case LONDRES:       // del ultimo domingo de marzo al ultimo de octubre (01:00 UTC)
         return (utc >= Fecha(a, 3, Domingo(a, 3, -1), 1) && utc < Fecha(a, 10, Domingo(a, 10, -1), 1)) ? 1 : 0;
      case SIDNEY:        // de abril a octubre sin horario de verano (cambia a las 16:00 UTC del sabado)
         return (utc >= Fecha(a, 4, Domingo(a, 4, 1), 0) - 8 * HORA && utc < Fecha(a, 10, Domingo(a, 10, 1), 0) - 8 * HORA) ? 10 : 11;
     }
   return 0;
  }

// Una hora local de una ciudad (medianoche de su fecha + segundos) en UTC.
datetime LocalAUtc(const ZONA z, const datetime local)
  {
   datetime aprox = local - Desfase(z, local) * HORA;
   return local - Desfase(z, aprox) * HORA;
  }

// El servidor va HorasServidorNY delante de Nueva York (FTMO cambia de horario con EE. UU.).
datetime UtcAServidor(const datetime utc)
  {
   return utc + (Desfase(NUEVA_YORK, utc) + HorasServidorNY) * HORA;
  }

datetime AhoraServidor()
  {
   return UtcAServidor(TimeGMT());
  }

// "HH:MM-HH:MM" en segundos desde la medianoche.
bool Horas(const string texto, int &desde, int &hasta)
  {
   string partes[];
   if(StringSplit(texto, '-', partes) != 2)
      return false;
   string a[], b[];
   if(StringSplit(partes[0], ':', a) != 2 || StringSplit(partes[1], ':', b) != 2)
      return false;
   desde = (int)StringToInteger(a[0]) * HORA + (int)StringToInteger(a[1]) * 60;
   hasta = (int)StringToInteger(b[0]) * HORA + (int)StringToInteger(b[1]) * 60;
   if(hasta <= desde)
      hasta += DIA;   // cruza la medianoche
   return true;
  }

//--- Dibujo ------------------------------------------------------------

// Un color mezclado con el fondo del grafico (para que el relleno no tape).
color Suave(const color c, const double cuanto)
  {
   color f = (color)ChartGetInteger(0, CHART_COLOR_BACKGROUND);
   int r = (int)MathRound((c & 0xFF) * cuanto + (f & 0xFF) * (1 - cuanto));
   int v = (int)MathRound(((c >> 8) & 0xFF) * cuanto + ((f >> 8) & 0xFF) * (1 - cuanto));
   int a = (int)MathRound(((c >> 16) & 0xFF) * cuanto + ((f >> 16) & 0xFF) * (1 - cuanto));
   return (color)(r | (v << 8) | (a << 16));
  }

void Comun(const string id, const color c)
  {
   ObjectSetInteger(0, id, OBJPROP_COLOR, c);
   ObjectSetInteger(0, id, OBJPROP_SELECTABLE, false);
   ObjectSetInteger(0, id, OBJPROP_HIDDEN, true);
  }

void Caja(const string nombre, const datetime t1, const datetime t2, const double alto, const double bajo, const color c, const string texto)
  {
   string id = PREFIJO + nombre;
   if(ObjectFind(0, id) < 0)
      ObjectCreate(0, id, OBJ_RECTANGLE, 0, t1, alto, t2, bajo);
   ObjectSetInteger(0, id, OBJPROP_TIME, 0, t1);
   ObjectSetDouble(0, id, OBJPROP_PRICE, 0, alto);
   ObjectSetInteger(0, id, OBJPROP_TIME, 1, t2);
   ObjectSetDouble(0, id, OBJPROP_PRICE, 1, bajo);
   ObjectSetInteger(0, id, OBJPROP_FILL, Relleno);
   ObjectSetInteger(0, id, OBJPROP_BACK, true);
   ObjectSetInteger(0, id, OBJPROP_STYLE, STYLE_DOT);
   Comun(id, Relleno ? Suave(c, 0.16) : c);
   if(!Etiquetas)
      return;
   string tid = id + "_t";
   if(ObjectFind(0, tid) < 0)
      ObjectCreate(0, tid, OBJ_TEXT, 0, t1, alto);
   ObjectSetInteger(0, tid, OBJPROP_TIME, 0, t1);
   ObjectSetDouble(0, tid, OBJPROP_PRICE, 0, alto);
   ObjectSetString(0, tid, OBJPROP_TEXT, texto);
   ObjectSetInteger(0, tid, OBJPROP_FONTSIZE, 8);
   ObjectSetInteger(0, tid, OBJPROP_ANCHOR, ANCHOR_LEFT_LOWER);
   Comun(tid, c);
  }

// Maximo y minimo entre dos instantes del servidor (velas de 5 minutos o, si
// faltan, las del propio grafico).
bool Rango(const datetime desde, const datetime hasta, double &alto, double &bajo)
  {
   datetime ahora = AhoraServidor();
   if(desde > ahora)
      return false;
   datetime fin = hasta < ahora ? hasta : ahora;
   MqlRates r[];
   int n = CopyRates(_Symbol, PERIOD_M5, desde, fin - 1, r);
   if(n <= 0 && _Period != PERIOD_M5 && PeriodSeconds(_Period) <= HORA)
      n = CopyRates(_Symbol, _Period, desde, fin - 1, r);
   if(n <= 0)
      return false;
   alto = r[0].high;
   bajo = r[0].low;
   for(int i = 1; i < n; i++)
     {
      alto = MathMax(alto, r[i].high);
      bajo = MathMin(bajo, r[i].low);
     }
   return true;
  }

// Las cajas de una sesion en los ultimos dias habiles de su ciudad.
void Sesion(const ZONA z, const string nombre, const string horas, const color c)
  {
   int desde, hasta;
   if(!Horas(horas, desde, hasta))
      return;
   datetime g = TimeGMT();
   datetime local = g + Desfase(z, g) * HORA;
   datetime hoy = local - local % DIA;
   double alto, bajo;
   for(int k = 0; k <= DiasAtras; k++)
     {
      datetime d = hoy - k * DIA;
      MqlDateTime x;
      TimeToStruct(d, x);
      if(x.day_of_week == 0 || x.day_of_week == 6)
         continue;
      datetime t1 = UtcAServidor(LocalAUtc(z, d + desde));
      datetime t2 = UtcAServidor(LocalAUtc(z, d + hasta));
      if(Rango(t1, t2, alto, bajo))
         Caja(nombre + "_" + TimeToString(d, TIME_DATE), t1, t2, alto, bajo, c, nombre);
     }
  }

void Dibujar()
  {
   // De la mas temprana a la mas tarde: la de Nueva York queda encima.
   if(VerSidney)
      Sesion(SIDNEY, "Sidney", HorasSidney, ColorSidney);
   if(VerTokio)
      Sesion(TOKIO, "Tokio", HorasTokio, ColorTokio);
   if(VerLondres)
      Sesion(LONDRES, "Londres", HorasLondres, ColorLondres);
   if(VerNuevaYork)
      Sesion(NUEVA_YORK, "Nueva York", HorasNuevaYork, ColorNuevaYork);
   ChartRedraw(0);
  }

//--- Eventos --------------------------------------------------------------

int OnInit()
  {
   IndicatorSetString(INDICATOR_SHORTNAME, "Sesiones");
   ObjectsDeleteAll(0, PREFIJO);
   EventSetTimer(30);
   Dibujar();
   return INIT_SUCCEEDED;
  }

void OnDeinit(const int reason)
  {
   EventKillTimer();
   ObjectsDeleteAll(0, PREFIJO);
   ChartRedraw(0);
  }

void OnTimer()
  {
   Dibujar();
  }

int OnCalculate(const int rates_total, const int prev_calculated, const int begin, const double &price[])
  {
   if(prev_calculated == 0)
      Dibujar();
   return rates_total;
  }
//+------------------------------------------------------------------+
