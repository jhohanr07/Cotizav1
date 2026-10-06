"use client";

import Image from "next/image";
import React, { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Loader2, Mail } from "lucide-react";
import {
  fetchCategorias,
  fetchEquipos,
  fetchVendedores,
  saveQuoteAndSendEmail,
  type CategoriaFinanciamiento,
  type Equipo,
  type PlazoCategoria,
  type ReglaInicial,
} from "@/lib/apps-script-api";

// Las categorías, la inicial mínima/sugerida y las tasas por plazo salen de la
// hoja "CATEGORIA" del Google Sheet. Solo estos valores no están en la hoja:
const VAT_RATE = 0.16;
const MIN_INITIAL_RATE_DEFAULT = 0.2;
const SUGGESTED_INITIAL_RATE_DEFAULT = 0.25;
const ACCESS_PASSWORD = "BNH2026";

// Categorías (nombre normalizado) que no permiten pagar el I.V.A. por separado
const CATEGORIES_WITHOUT_SEPARATE_VAT = ["teair"];

// Inicial mínima absoluta (USD) y paso de redondeo cuando la hoja no define uno
const MIN_INITIAL_AMOUNT = 3500;
const INITIAL_STEP = 500;

// Precio de contado: el monto incluye 3 %; el I.V.A. = (monto / 1,03) x 16 %
const CONTADO_DIVISOR = 1.03;

type CategoryConfig = {
  nombre: string;
  minInitialRate: number;
  minDigits: number | null;
  suggestedInitialRate: number;
  suggestedDigits: number | null;
  terms: PlazoCategoria[];
  canPayVATSeparately: boolean;
};

type PaymentMode = "si" | "no";

function formatCurrency(value: number) {
  if (!Number.isFinite(value)) return "$0.00";

  return new Intl.NumberFormat("es-VE", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function roundUpToNearest5(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.ceil(value / 5) * 5;
}

function roundUpToMultiple(value: number, step: number) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.ceil(value / step) * step;
}

function formatNumberInput(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "";
  return value.toFixed(2);
}

function normalizeText(value: string) {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

// Redondea hacia arriba igual que REDONDEAR.MAS(valor; digitos) de la hoja.
// Sin dígitos definidos se usa el múltiplo de $500 de siempre.
function roundUpByRule(value: number, digits: number | null) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (digits === null) return roundUpToMultiple(value, INITIAL_STEP);
  const step = digits < 0 ? Math.pow(10, -digits) : 1;
  return Math.ceil(value / step) * step;
}

function toRule(rule: ReglaInicial | null, fallbackRate: number) {
  return {
    rate: rule?.pct ?? fallbackRate,
    digits: rule?.digitos ?? null,
  };
}

// Cuota nivelada (PMT) con tasa mensual; sin tasa, reparto simple.
function monthlyPaymentFor(principal: number, monthlyRate: number, n: number) {
  if (n <= 0) return 0;
  if (monthlyRate <= 0) return principal / n;
  return (principal * monthlyRate) / (1 - Math.pow(1 + monthlyRate, -n));
}

export default function Page() {
  const [isAuthenticated, setIsAuthenticated] =
    useState(false);

  const [password, setPassword] =
    useState("");

  const [accessError, setAccessError] =
    useState("");

  const handleLogin = () => {
    if (password === ACCESS_PASSWORD) {
      setIsAuthenticated(true);
      setAccessError("");
    } else {
      setAccessError("Clave incorrecta.");
    }
  };

  if (!isAuthenticated) {
    return (
      <div
        className="min-h-screen bg-[#f3f5f7] px-6 py-10"
        style={{
          fontFamily:
            "Verdana, sans-serif",
        }}
      >
        <div className="mx-auto flex max-w-md flex-col items-center justify-center">
          <div className="mb-8 rounded-3xl bg-white px-8 py-6 shadow-sm ring-1 ring-gray-200">
            <Image
              src="/logo-bnh.jpeg"
              alt="BNH Medical"
              width={360}
              height={180}
              className="h-auto w-[280px] md:w-[340px]"
              priority
            />
          </div>

          <Card className="w-full rounded-3xl border-0 bg-white shadow-lg ring-1 ring-gray-200">
            <CardHeader className="pb-2 text-center">
              <CardTitle className="text-3xl font-bold text-gray-900">
                Acceso privado
              </CardTitle>

              <p className="mt-2 text-sm text-gray-600">
                Ingrese la clave para acceder
                a la calculadora de
                financiamiento
              </p>
            </CardHeader>

            <CardContent className="space-y-5 pt-4">
              <div className="space-y-3">
                <Label className="block text-base font-medium text-gray-800">
                  Clave de acceso
                </Label>

                <Input
                  type="password"
                  value={password}
                  onChange={(e) =>
                    setPassword(
                      e.target.value
                    )
                  }
                  placeholder="Ingrese su clave"
                  className="h-12 rounded-xl"
                />
              </div>

              {accessError && (
                <Alert className="border-red-200 bg-red-50">
                  <AlertDescription>
                    {accessError}
                  </AlertDescription>
                </Alert>
              )}

              <Button
                onClick={handleLogin}
                className="h-12 w-full rounded-xl bg-[#0d6f91] text-base font-semibold hover:bg-[#0a607d]"
              >
                Ingresar
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return <CalculadoraFinanciamientoBNH />;
}

function CalculadoraFinanciamientoBNH() {
  const [category, setCategory] = useState("");
  const [basePrice, setBasePrice] = useState("");
  const [contadoPriceInput, setContadoPriceInput] = useState("");
  const [initialAmount, setInitialAmount] = useState("");
  const [ivaFinancing, setIvaFinancing] = useState<PaymentMode>("si");
  const [installments, setInstallments] = useState("");

  // Interruptor "Ajustar": usa el "IVA ajustado" (columna G de PRECIO EQUIPOS)
  const [ajustarIva, setAjustarIva] = useState(false);

  // --- Categorías y condiciones (hoja CATEGORIA) ---
  const [categorias, setCategorias] = useState<CategoriaFinanciamiento[]>([]);
  const [categoriasLoading, setCategoriasLoading] = useState(false);
  const [categoriasError, setCategoriasError] = useState("");

  useEffect(() => {
    let active = true;

    async function loadCategorias() {
      setCategoriasLoading(true);
      setCategoriasError("");

      try {
        const data = await fetchCategorias();
        if (active) setCategorias(data);
      } catch (err) {
        if (active) {
          setCategoriasError(
            err instanceof Error
              ? err.message
              : "No se pudieron cargar las categorías."
          );
        }
      } finally {
        if (active) setCategoriasLoading(false);
      }
    }

    loadCategorias();

    return () => {
      active = false;
    };
  }, []);

  // --- Base de datos de equipos (hoja PRECIO EQUIPOS vía Apps Script) ---
  const [equipos, setEquipos] = useState<Equipo[]>([]);
  const [selectedEquipoId, setSelectedEquipoId] = useState("");
  const [equiposLoading, setEquiposLoading] = useState(false);
  const [equiposError, setEquiposError] = useState("");

  useEffect(() => {
    let active = true;

    async function loadEquipos() {
      setEquiposLoading(true);
      setEquiposError("");

      try {
        const data = await fetchEquipos();
        if (active) setEquipos(data);
      } catch (err) {
        if (active) {
          setEquiposError(
            err instanceof Error
              ? err.message
              : "No se pudo cargar la base de datos de equipos."
          );
        }
      } finally {
        if (active) setEquiposLoading(false);
      }
    }

    loadEquipos();

    return () => {
      active = false;
    };
  }, []);

  // --- Lista de vendedores (hoja VENDEDORES); si falla, se permite escribir el nombre ---
  const [vendedores, setVendedores] = useState<string[]>([]);
  const [vendedoresLoading, setVendedoresLoading] = useState(false);

  useEffect(() => {
    let active = true;

    async function loadVendedores() {
      setVendedoresLoading(true);

      try {
        const data = await fetchVendedores();
        if (active) setVendedores(data);
      } catch {
        if (active) setVendedores([]);
      } finally {
        if (active) setVendedoresLoading(false);
      }
    }

    loadVendedores();

    return () => {
      active = false;
    };
  }, []);

  // Al elegir el equipo se llenan de inmediato la categoría y los precios
  // (crédito y contado) según la hoja PRECIO EQUIPOS.
  const handleEquipoChange = (equipoId: string) => {
    setSelectedEquipoId(equipoId);

    const equipo = equipos.find((e) => e.id === equipoId);
    if (!equipo) return;

    const matched = categorias.find(
      (c) => normalizeText(c.nombre) === normalizeText(equipo.categoria)
    );
    if (matched) setCategory(matched.nombre);

    setBasePrice(formatNumberInput(equipo.precioCredito));
    setContadoPriceInput(formatNumberInput(equipo.precioContado));
  };

  // --- Datos del prospecto (lead) y vendedor, para la cotización ---
  const [leadName, setLeadName] = useState("");
  const [leadPhone, setLeadPhone] = useState("");
  const [leadEmail, setLeadEmail] = useState("");
  const [vendedorName, setVendedorName] = useState("");

  const [sendingQuote, setSendingQuote] = useState(false);
  const [sendQuoteError, setSendQuoteError] = useState("");
  const [sendQuoteSuccess, setSendQuoteSuccess] = useState("");

  const categoryConfig = useMemo<CategoryConfig | null>(() => {
    const found = categorias.find((c) => c.nombre === category);
    if (!found) return null;

    const min = toRule(found.inicialMinima, MIN_INITIAL_RATE_DEFAULT);
    const suggested = toRule(
      found.inicialSugerida,
      SUGGESTED_INITIAL_RATE_DEFAULT
    );

    return {
      nombre: found.nombre,
      minInitialRate: min.rate,
      minDigits: min.digits,
      suggestedInitialRate: suggested.rate,
      suggestedDigits: suggested.digits,
      terms: found.plazos,
      canPayVATSeparately: !CATEGORIES_WITHOUT_SEPARATE_VAT.includes(
        normalizeText(found.nombre)
      ),
    };
  }, [categorias, category]);

  const numericBase = Number(basePrice);
  const numericInitial = Number(initialAmount);
  const numericInstallments = Number(installments);
  const numericContado = Number(contadoPriceInput);

  const safeBaseForRules =
    Number.isFinite(numericBase) && numericBase > 0 ? numericBase : 0;

  // Inicial mínima y sugerida: porcentaje y redondeo vienen de la hoja CATEGORIA
  const minInitialAmount = useMemo(() => {
    if (!categoryConfig) return MIN_INITIAL_AMOUNT;
    const raw = safeBaseForRules * categoryConfig.minInitialRate;
    const value =
      categoryConfig.minDigits === null
        ? raw
        : roundUpByRule(raw, categoryConfig.minDigits);
    return Math.max(value, MIN_INITIAL_AMOUNT);
  }, [categoryConfig, safeBaseForRules]);

  // Inicial que se autocompleta: la mínima (entera)
  const autoInitialAmount = useMemo(
    () =>
      categoryConfig?.minDigits === null || !categoryConfig
        ? roundUpToMultiple(minInitialAmount, INITIAL_STEP)
        : Math.ceil(minInitialAmount),
    [categoryConfig, minInitialAmount]
  );

  const suggestedInitialAmount = useMemo(() => {
    if (!categoryConfig) return MIN_INITIAL_AMOUNT;
    return Math.max(
      roundUpByRule(
        safeBaseForRules * categoryConfig.suggestedInitialRate,
        categoryConfig.suggestedDigits
      ),
      MIN_INITIAL_AMOUNT
    );
  }, [categoryConfig, safeBaseForRules]);

  // I.V.A. estándar del crédito (16 % de la base); es el que entra al cálculo de la cuota
  const vatAmount = safeBaseForRules * VAT_RATE;

  // --- Contado: I.V.A. = (monto / 1,03) x 16 % ---
  const contadoMonto =
    Number.isFinite(numericContado) && numericContado > 0 ? numericContado : 0;
  const contadoIvaNormal = (contadoMonto / CONTADO_DIVISOR) * VAT_RATE;

  // --- "Ajustar": solo cambia el I.V.A. mostrado; se toma de la columna G de la lista ---
  const equipoSeleccionado = equipos.find((e) => e.id === selectedEquipoId);
  const ivaAjustadoLista = equipoSeleccionado?.ivaAjustado ?? 0;
  const ivaAjustadoDisponible = ivaAjustadoLista > 0;
  const usaAjuste = ajustarIva && ivaAjustadoDisponible;

  const creditoIva =
    safeBaseForRules > 0 ? (usaAjuste ? ivaAjustadoLista : vatAmount) : 0;
  const creditoTotal = safeBaseForRules + creditoIva;

  const contadoIva =
    contadoMonto > 0 ? (usaAjuste ? ivaAjustadoLista : contadoIvaNormal) : 0;
  const contadoTotal = contadoMonto + contadoIva;

  useEffect(() => {
    if (!categoryConfig) {
      setIvaFinancing("si");
      return;
    }

    if (!categoryConfig.canPayVATSeparately) {
      setIvaFinancing("si");
    }
  }, [categoryConfig]);

  // Si el plazo elegido no existe en la categoría, se limpia
  useEffect(() => {
    if (
      categoryConfig &&
      installments !== "" &&
      !categoryConfig.terms.some((t) => String(t.meses) === installments)
    ) {
      setInstallments("");
    }
  }, [categoryConfig, installments]);

  useEffect(() => {
    if (categoryConfig && Number.isFinite(numericBase) && numericBase > 0) {
      setInitialAmount(String(autoInitialAmount));
    } else if (!basePrice) {
      setInitialAmount("");
    }
  }, [categoryConfig, numericBase, autoInitialAmount, basePrice]);

  const validations = useMemo(() => {
    const errors: string[] = [];

    if (!categoryConfig) return errors;

    if (basePrice !== "" && (!Number.isFinite(numericBase) || numericBase <= 0)) {
      errors.push("No válido: el precio de crédito debe ser mayor a cero.");
    }

    if (
      contadoPriceInput !== "" &&
      (!Number.isFinite(numericContado) || numericContado < 0)
    ) {
      errors.push("No válido: el precio de contado debe ser un valor numérico válido.");
    }

    if (
      initialAmount !== "" &&
      (!Number.isFinite(numericInitial) || numericInitial < 0)
    ) {
      errors.push("No válido: el monto inicial debe ser un valor numérico válido.");
    }

    if (
      installments !== "" &&
      (!Number.isInteger(numericInstallments) || numericInstallments <= 0)
    ) {
      errors.push("No válido: la cantidad de cuotas debe ser un entero mayor a cero.");
    }

    if (
      initialAmount !== "" &&
      Number.isFinite(numericInitial) &&
      numericInitial >= 0 &&
      !Number.isInteger(numericInitial)
    ) {
      errors.push("No válido: la inicial debe ser un número entero (ej. 5000, 5500, 6000).");
    }

    if (
      initialAmount !== "" &&
      Number.isFinite(numericInitial) &&
      numericInitial < MIN_INITIAL_AMOUNT
    ) {
      errors.push(
        `No válido: la inicial no puede ser menor a ${formatCurrency(
          MIN_INITIAL_AMOUNT
        )}. Por favor cambie el monto de la inicial.`
      );
    } else if (
      Number.isFinite(numericBase) &&
      numericBase > 0 &&
      Number.isFinite(numericInitial) &&
      numericInitial < minInitialAmount
    ) {
      errors.push(
        `No válido: la inicial debe ser al menos ${Math.round(
          categoryConfig.minInitialRate * 100
        )}% de la base imponible (${formatCurrency(
          minInitialAmount
        )}). Por favor cambie el monto.`
      );
    }

    if (
      Number.isFinite(numericBase) &&
      numericBase > 0 &&
      Number.isFinite(numericInitial) &&
      numericInitial >= numericBase
    ) {
      errors.push("No válido: la inicial debe ser menor a la base imponible.");
    }

    if (
      installments !== "" &&
      Number.isInteger(numericInstallments) &&
      !categoryConfig.terms.some((t) => t.meses === numericInstallments)
    ) {
      errors.push("No válido: este plazo no está disponible para la categoría.");
    }

    if (!categoryConfig.canPayVATSeparately && ivaFinancing === "no") {
      errors.push("No válido: esta categoría no permite pagar el I.V.A. por separado.");
    }

    return errors;
  }, [
    categoryConfig,
    basePrice,
    contadoPriceInput,
    initialAmount,
    installments,
    ivaFinancing,
    numericBase,
    numericContado,
    numericInitial,
    numericInstallments,
    minInitialAmount,
  ]);

  const calculations = useMemo(() => {
    const safeBase = safeBaseForRules;

    const safeInitial =
      Number.isFinite(numericInitial) && numericInitial >= 0
        ? numericInitial
        : 0;

    const safeInstallments =
      Number.isInteger(numericInstallments) && numericInstallments > 0
        ? numericInstallments
        : 0;

    const safeVat = safeBase > 0 ? vatAmount : 0;
    const ivaSeparate = ivaFinancing === "no" ? safeVat : 0;

    const empty = {
      roundedMonthlyPayment: 0,
      totalToPay: safeInitial,
      ivaToPayField: ivaSeparate,
      financedAmount: 0,
    };

    if (!categoryConfig || safeBase <= 0 || safeInstallments <= 0) {
      return empty;
    }

    // Tasa mensual del plazo, tomada de la hoja CATEGORIA: factor^(1/meses) - 1
    const term = categoryConfig.terms.find((t) => t.meses === safeInstallments);
    if (!term) return empty;

    // (BASE - INICIAL) = MONTO FINANCIADO
    const financedAmount = safeBase - safeInitial;
    if (financedAmount <= 0) return empty;

    // Cuota nivelada sobre el monto financiado; si el I.V.A. se financia,
    // se reparte en las cuotas (sin interés adicional).
    const capitalAndInterest = monthlyPaymentFor(
      financedAmount,
      term.tasaMensual,
      safeInstallments
    );
    const ivaPerInstallment =
      ivaFinancing === "si" ? safeVat / safeInstallments : 0;

    const roundedMonthlyPayment = roundUpToNearest5(
      capitalAndInterest + ivaPerInstallment
    );

    const totalToPay =
      safeInitial + ivaSeparate + roundedMonthlyPayment * safeInstallments;

    return {
      roundedMonthlyPayment,
      totalToPay,
      ivaToPayField: ivaSeparate,
      financedAmount,
    };
  }, [
    safeBaseForRules,
    numericInitial,
    numericInstallments,
    vatAmount,
    ivaFinancing,
    categoryConfig,
  ]);

  const isValid =
    !!categoryConfig &&
    Number.isFinite(numericBase) &&
    numericBase > 0 &&
    Number.isFinite(numericInitial) &&
    numericInitial >= minInitialAmount &&
    Number.isInteger(numericInstallments) &&
    numericInstallments > 0 &&
    categoryConfig.terms.some((t) => t.meses === numericInstallments) &&
    validations.length === 0 &&
    Number.isInteger(numericInitial) &&
    numericInitial >= MIN_INITIAL_AMOUNT &&
    calculations.roundedMonthlyPayment > 0;

  const handleReset = () => {
    setCategory("");
    setBasePrice("");
    setContadoPriceInput("");
    setInitialAmount("");
    setIvaFinancing("si");
    setInstallments("");
    setAjustarIva(false);
    setSelectedEquipoId("");
    setSendQuoteError("");
    setSendQuoteSuccess("");
  };

  const handleSendQuote = async () => {
    setSendQuoteError("");
    setSendQuoteSuccess("");

    if (!isValid) {
      setSendQuoteError(
        "Complete correctamente los datos de la operación antes de enviar la cotización."
      );
      return;
    }

    if (!leadName.trim() || !leadEmail.trim() || !vendedorName.trim()) {
      setSendQuoteError(
        "Complete el nombre del lead, su email y el vendedor antes de enviar."
      );
      return;
    }

    setSendingQuote(true);

    try {
      const result = await saveQuoteAndSendEmail({
        leadName: leadName.trim(),
        leadPhone: leadPhone.trim(),
        leadEmail: leadEmail.trim(),
        vendedorName: vendedorName.trim(),
        equipo: equipoSeleccionado?.nombre ?? "",
        categoria: categoryConfig?.nombre ?? "",
        basePrice: numericBase,
        initialAmount: numericInitial,
        installments: numericInstallments,
        monthlyPayment: calculations.roundedMonthlyPayment,
        totalToPay: calculations.totalToPay,
        ivaFinancing,
        ivaToPay: calculations.ivaToPayField,
        creditoIva,
        creditoTotal,
        ...(contadoMonto > 0
          ? { contadoPrecio: contadoMonto, contadoIva, contadoTotal }
          : {}),
        ajustado: usaAjuste,
        logoUrl: `${window.location.origin}/logo-bnh.jpeg`,
      });

      const numeroTxt = result.numero ? ` (N° ${result.numero})` : "";

      setSendQuoteSuccess(
        result.warning
          ? `Cotización${numeroTxt} guardada y enviada al lead con el PDF adjunto. ${result.warning}`
          : `Cotización${numeroTxt} guardada en el Funel de Venta y enviada por correo con el PDF adjunto.`
      );
    } catch (err) {
      setSendQuoteError(
        err instanceof Error
          ? err.message
          : "No se pudo enviar la cotización. Intente nuevamente."
      );
    } finally {
      setSendingQuote(false);
    }
  };

  return (
    <div
      className="min-h-screen bg-[#f3f5f7] px-4 py-6 md:px-6 md:py-8"
      style={{
        fontFamily:
          "Verdana, sans-serif",
      }}
    >
      <div className="mx-auto max-w-7xl">
        <div className="mb-6 bg-transparent md:mb-8">
          <div className="flex flex-col items-center gap-5 text-center md:flex-row md:items-center md:text-left">
            <div className="rounded-3xl bg-white px-6 py-4 shadow-sm ring-1 ring-gray-200">
              <Image
                src="/logo-bnh.jpeg"
                alt="BNH Medical"
                width={240}
                height={120}
                className="h-auto w-[190px] md:w-[220px]"
                priority
              />
            </div>

            <div>
              <h1 className="text-3xl font-bold tracking-tight text-gray-900 md:text-4xl">
                Calculadora de
                Financiamiento
              </h1>

              <p className="mt-2 text-sm text-gray-600 md:text-base">
                Simulación comercial
                para planes de
                financiamiento
              </p>

              <div className="mt-4 inline-flex rounded-full bg-[#0d6f91]/10 px-4 py-2 text-sm font-medium text-[#0d6f91]">
                BNH Medical ·
                Herramienta interna
              </div>
            </div>
          </div>
        </div>

        <Card className="mb-6 rounded-3xl border-0 shadow-sm ring-1 ring-gray-200 md:mb-8">
          <CardHeader>
            <CardTitle className="text-2xl text-gray-900">
              Datos del prospecto y vendedor
            </CardTitle>
          </CardHeader>

          <CardContent>
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <Label className="mb-2 block">
                  Nombre del lead
                </Label>

                <Input
                  type="text"
                  value={leadName}
                  onChange={(e) =>
                    setLeadName(e.target.value)
                  }
                  placeholder="Ej. Dr. Juan Rodríguez"
                  className="rounded-xl"
                />
              </div>

              <div>
                <Label className="mb-2 block">
                  Teléfono
                </Label>

                <Input
                  type="tel"
                  value={leadPhone}
                  onChange={(e) =>
                    setLeadPhone(e.target.value)
                  }
                  placeholder="Ej. 0414-1234567"
                  className="rounded-xl"
                />
              </div>

              <div>
                <Label className="mb-2 block">
                  Email
                </Label>

                <Input
                  type="email"
                  value={leadEmail}
                  onChange={(e) =>
                    setLeadEmail(e.target.value)
                  }
                  placeholder="Ej. doctor@clinica.com"
                  className="rounded-xl"
                />
              </div>

              <div>
                <Label className="mb-2 block">
                  Vendedor
                </Label>

                {vendedores.length > 0 ? (
                  <Select
                    value={vendedorName}
                    onValueChange={setVendedorName}
                  >
                    <SelectTrigger
                      className="rounded-xl"
                      style={{
                        fontFamily: "Verdana, sans-serif",
                      }}
                    >
                      <SelectValue placeholder="Seleccione un vendedor" />
                    </SelectTrigger>

                    <SelectContent
                      style={{
                        fontFamily: "Verdana, sans-serif",
                      }}
                    >
                      {vendedores.map((nombre) => (
                        <SelectItem
                          key={nombre}
                          value={nombre}
                          style={{
                            fontFamily: "Verdana, sans-serif",
                          }}
                        >
                          {nombre}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    type="text"
                    value={vendedorName}
                    onChange={(e) =>
                      setVendedorName(e.target.value)
                    }
                    placeholder={
                      vendedoresLoading
                        ? "Cargando vendedores..."
                        : "Ej. María Pérez"
                    }
                    className="rounded-xl"
                  />
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card className="rounded-3xl border-0 shadow-sm ring-1 ring-gray-200">
            <CardHeader>
              <CardTitle className="text-2xl text-gray-900">
                Datos de la operación
              </CardTitle>
            </CardHeader>

            <CardContent className="space-y-5">
              <div>
                <Label className="mb-2 block">
                  Equipo
                </Label>

                <Select
                  value={selectedEquipoId}
                  onValueChange={handleEquipoChange}
                  disabled={equiposLoading || equipos.length === 0}
                >
                  <SelectTrigger
                    className="rounded-xl"
                    style={{
                      fontFamily: "Verdana, sans-serif",
                    }}
                  >
                    <SelectValue
                      placeholder={
                        equiposLoading
                          ? "Cargando equipos..."
                          : "Seleccione un equipo (opcional)"
                      }
                    />
                  </SelectTrigger>

                  <SelectContent
                    style={{
                      fontFamily: "Verdana, sans-serif",
                    }}
                  >
                    {equipos.map((equipo) => {
                      const sinPrecio =
                        equipo.precioCredito <= 0 && equipo.precioContado <= 0;

                      return (
                        <SelectItem
                          key={equipo.id}
                          value={equipo.id}
                          disabled={sinPrecio}
                          style={{
                            fontFamily: "Verdana, sans-serif",
                          }}
                        >
                          {equipo.nombre}
                          {sinPrecio ? " — sin precio" : ""}
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>

                {equiposError ? (
                  <p className="mt-2 text-xs text-red-600">
                    {equiposError}
                  </p>
                ) : (
                  <p className="mt-2 text-xs text-gray-500">
                    Al seleccionar un equipo se completan
                    automáticamente la categoría y los precios de
                    crédito y de contado; puede ajustarlos manualmente.
                  </p>
                )}
              </div>

              <div>
                <Label className="mb-2 block">
                  Categoría
                </Label>

                <Select
                  value={category}
                  onValueChange={setCategory}
                  disabled={categoriasLoading || categorias.length === 0}
                >
                  <SelectTrigger
                    className="rounded-xl"
                    style={{
                      fontFamily: "Verdana, sans-serif",
                    }}
                  >
                    <SelectValue
                      placeholder={
                        categoriasLoading
                          ? "Cargando categorías..."
                          : "Seleccione una categoría"
                      }
                    />
                  </SelectTrigger>

                  <SelectContent
                    style={{
                      fontFamily: "Verdana, sans-serif",
                    }}
                  >
                    {categorias.map((cat) => (
                      <SelectItem
                        key={cat.nombre}
                        value={cat.nombre}
                        style={{
                          fontFamily: "Verdana, sans-serif",
                        }}
                      >
                        {cat.nombre}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                {categoriasError && (
                  <p className="mt-2 text-xs text-red-600">
                    {categoriasError}
                  </p>
                )}
              </div>

              <div>
                <Label className="mb-2 block">
                  Precio de crédito (base imponible)
                </Label>

                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={basePrice}
                  onChange={(e) =>
                    setBasePrice(
                      e.target.value
                    )
                  }
                  placeholder="Ej. 10000"
                  className="rounded-xl"
                />
              </div>

              <div>
                <Label className="mb-2 block">
                  Precio de contado
                </Label>

                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={contadoPriceInput}
                  onChange={(e) =>
                    setContadoPriceInput(e.target.value)
                  }
                  placeholder="Ej. 10300"
                  className="rounded-xl"
                />
              </div>

              <div>
                <Label className="mb-2 block">
                  Monto inicial
                </Label>

                <Input
                  type="number"
                  min={MIN_INITIAL_AMOUNT}
                  step={INITIAL_STEP}
                  value={initialAmount}
                  onChange={(e) =>
                    setInitialAmount(
                      e.target.value
                    )
                  }
                  placeholder="Ej. 5000"
                  className="rounded-xl"
                />

                {categoryConfig ? (
                  <div className="mt-2 space-y-1 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-gray-700">
                    <p>
                      Inicial mínima{" "}
                      {Math.round(categoryConfig.minInitialRate * 100)}%:{" "}
                      <span className="font-semibold">
                        {formatCurrency(minInitialAmount)}
                      </span>
                    </p>
                    <p>
                      Inicial sugerida{" "}
                      {Math.round(categoryConfig.suggestedInitialRate * 100)}%:{" "}
                      <span className="font-semibold">
                        {formatCurrency(suggestedInitialAmount)}
                      </span>
                    </p>
                  </div>
                ) : (
                  <p className="mt-2 text-xs text-gray-500">
                    Seleccione una categoría para ver la inicial mínima y sugerida
                  </p>
                )}
              </div>

              <div>
                <Label className="mb-2 block">
                  Financiamiento del
                  I.V.A.
                </Label>

                <Select
                  value={ivaFinancing}
                  onValueChange={(
                    value: PaymentMode
                  ) =>
                    setIvaFinancing(
                      value
                    )
                  }
                >
                  <SelectTrigger
                    className="rounded-xl"
                    style={{
                      fontFamily:
                        "Verdana, sans-serif",
                    }}
                  >
                    <SelectValue placeholder="Seleccione" />
                  </SelectTrigger>

                  <SelectContent
                    style={{
                      fontFamily:
                        "Verdana, sans-serif",
                    }}
                  >
                    <SelectItem
                      value="si"
                      style={{
                        fontFamily:
                          "Verdana, sans-serif",
                      }}
                    >
                      Sí
                    </SelectItem>

                    {categoryConfig?.canPayVATSeparately ? (
                      <SelectItem
                        value="no"
                        style={{
                          fontFamily:
                            "Verdana, sans-serif",
                        }}
                      >
                        No
                      </SelectItem>
                    ) : (
                      <SelectItem
                        value="no"
                        disabled
                        style={{
                          fontFamily:
                            "Verdana, sans-serif",
                        }}
                      >
                        No
                      </SelectItem>
                    )}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label className="mb-2 block">
                  Cantidad de cuotas
                </Label>

                <Select
                  value={installments}
                  onValueChange={setInstallments}
                  disabled={!categoryConfig || categoryConfig.terms.length === 0}
                >
                  <SelectTrigger
                    className="rounded-xl"
                    style={{
                      fontFamily: "Verdana, sans-serif",
                    }}
                  >
                    <SelectValue placeholder="Seleccione el plazo" />
                  </SelectTrigger>

                  <SelectContent
                    style={{
                      fontFamily: "Verdana, sans-serif",
                    }}
                  >
                    {(categoryConfig?.terms ?? []).map((term) => (
                      <SelectItem
                        key={term.meses}
                        value={String(term.meses)}
                        style={{
                          fontFamily: "Verdana, sans-serif",
                        }}
                      >
                        {term.meses} cuotas
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <p className="mt-2 text-xs text-gray-500">
                  {categoryConfig
                    ? `Plazos disponibles: ${categoryConfig.terms
                        .map((t) => t.meses)
                        .join(", ")} cuotas`
                    : "Seleccione una categoría para ver los plazos disponibles"}
                </p>
              </div>

              {validations.length >
                0 && (
                <Alert className="border-red-200 bg-red-50">
                  <AlertDescription>
                    <div className="space-y-1">
                      {validations.map(
                        (
                          message,
                          index
                        ) => (
                          <div
                            key={
                              index
                            }
                          >
                            {
                              message
                            }
                          </div>
                        )
                      )}
                    </div>
                  </AlertDescription>
                </Alert>
              )}

              <Button
                variant="outline"
                onClick={
                  handleReset
                }
                className="rounded-xl border-gray-300"
              >
                Restablecer
              </Button>
            </CardContent>
          </Card>

          <Card className="rounded-3xl border-0 shadow-sm ring-1 ring-gray-200">
            <CardHeader>
              <CardTitle className="text-2xl text-gray-900">
                Resultados
              </CardTitle>
            </CardHeader>

            <CardContent>
              {/* Interruptor global: afecta el I.V.A. de los cuadros "Base + I.V.A." */}
              <div className="mb-4 flex items-center justify-between gap-3 rounded-2xl border border-gray-200 bg-white px-4 py-3">
                <div>
                  <p className="text-sm font-semibold text-gray-800">
                    Aplicar Ajuste
                  </p>
                  <p className="text-xs text-gray-500">
                    
                  </p>
                </div>

                <button
                  type="button"
                  role="switch"
                  aria-checked={ajustarIva}
                  aria-label="Ajustar I.V.A."
                  onClick={() => setAjustarIva((v) => !v)}
                  className="flex items-center"
                >
                  <span
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                      ajustarIva ? "bg-[#0d6f91]" : "bg-gray-300"
                    }`}
                  >
                    <span
                      className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
                        ajustarIva ? "translate-x-5" : "translate-x-0.5"
                      }`}
                    />
                  </span>
                </button>
              </div>

              {ajustarIva && !ivaAjustadoDisponible && (
                <Alert className="mb-4 border-amber-200 bg-amber-50">
                  <AlertDescription>
                    {selectedEquipoId
                      ? "El I.V.A. normal."
                      : "Seleccione un equipo de la lista para aplicar su I.V.A. ; mientras tanto se usa el I.V.A. normal."}
                  </AlertDescription>
                </Alert>
              )}

              {/* ===== CONTADO ===== */}
              <div className="mb-6 rounded-3xl border border-gray-200 bg-gray-50 p-5">
                <h3 className="mb-4 text-xl font-bold text-gray-900">
                  De contado
                </h3>

                <div className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
                  <Item
                    label="Precio de contado"
                    value={formatCurrency(contadoMonto)}
                  />

                  <Item
                    label={
                      usaAjuste
                        ? "I.V.A. "
                        : "I.V.A. "
                    }
                    value={formatCurrency(contadoIva)}
                  />
                </div>

                <TotalBox
                  title="Total a pagar"
                  base={contadoMonto}
                  iva={contadoIva}
                  total={contadoTotal}
                  ajustado={usaAjuste}
                />
              </div>

              {/* ===== CRÉDITO ===== */}
              <div className="rounded-3xl border border-gray-200 bg-gray-50 p-5">
                <h3 className="mb-4 text-xl font-bold text-gray-900">
                  Crédito
                </h3>

                <div className="mb-4 rounded-3xl bg-[#0b0b0b] p-8 text-white shadow-lg">
                  <p className="text-base font-medium text-gray-300">
                    Cuota mensual
                  </p>

                  <p className="mt-3 text-5xl font-extrabold tracking-tight md:text-6xl">
                    {isValid
                      ? formatCurrency(calculations.roundedMonthlyPayment)
                      : "$0.00"}
                  </p>

                  <p className="mt-4 text-sm font-medium text-gray-300">
                    Total de pagos:{" "}
                    <span className="font-bold text-white">
                      {isValid ? numericInstallments : 0}
                    </span>
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-4 text-sm">
                  <Item
                    label="Cantidad de cuotas"
                    value={String(isValid ? numericInstallments : 0)}
                  />

                  <Item
                    label="Monto de inicial"
                    value={formatCurrency(numericInitial || 0)}
                  />

                  <Item
                    label="Monto financiado"
                    value={formatCurrency(
                      isValid ? calculations.financedAmount : 0
                    )}
                  />

                  <Item
                    label="I.V.A. a pagar en Bs"
                    value={formatCurrency(calculations.ivaToPayField)}
                  />

                  <Item
                    label="Total a pagar"
                    value={formatCurrency(calculations.totalToPay)}
                  />
                </div>

                <TotalBox
                  title="Total crédito"
                  base={safeBaseForRules}
                  iva={creditoIva}
                  total={creditoTotal}
                  ajustado={usaAjuste}
                />
              </div>

              <Button
                onClick={handleSendQuote}
                disabled={sendingQuote}
                className="mt-6 h-12 w-full rounded-xl bg-[#0d6f91] text-base font-semibold hover:bg-[#0a607d]"
              >
                {sendingQuote ? (
                  <>
                    <Loader2 className="mr-2 size-4 animate-spin" />
                    Enviando...
                  </>
                ) : (
                  <>
                    <Mail className="mr-2 size-4" />
                    Enviar cotización por correo
                  </>
                )}
              </Button>

              <p className="mt-2 text-xs text-gray-500">
                Se generará el PDF de la cotización y se
                enviará por correo al lead (y al vendedor, si
                su correo está registrado en la hoja
                &quot;VENDEDORES&quot;); quedará guardada en
                el Funel de Venta.
              </p>

              {sendQuoteError && (
                <Alert className="mt-4 border-red-200 bg-red-50">
                  <AlertDescription>
                    {sendQuoteError}
                  </AlertDescription>
                </Alert>
              )}

              {sendQuoteSuccess && (
                <Alert className="mt-4 border-green-200 bg-green-50">
                  <AlertDescription>
                    {sendQuoteSuccess}
                  </AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Item({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      <p className="text-gray-500">
        {label}
      </p>

      <p className="mt-1 font-semibold text-gray-900">
        {value}
      </p>
    </div>
  );
}

function TotalBox({
  title,
  base,
  iva,
  total,
  ajustado,
}: {
  title: string;
  base: number;
  iva: number;
  total: number;
  ajustado: boolean;
}) {
  return (
    <div className="mt-4 rounded-2xl border border-[#0d6f91]/30 bg-[#0d6f91]/10 p-4">
      <p className="text-sm font-medium text-[#0d6f91]">
        {title} (base + I.V.A.{ajustado ? " " : ""})
      </p>

      <p className="mt-1 text-3xl font-extrabold tracking-tight text-gray-900">
        {formatCurrency(total)}
      </p>

      <p className="mt-1 text-xs text-gray-600">
        {formatCurrency(base)} + {formatCurrency(iva)}
      </p>
    </div>
  );
}
