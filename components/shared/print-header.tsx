import { MapPin, Phone } from "lucide-react";

interface PrintHeaderProps {
  clinicName: string;
  clinicAddress?: string | null;
  clinicPhone?: string | null;
  logoUrl?: string | null;
  documentName: string;
  generatedAt: string;
}

export function PrintHeader({
  clinicName,
  clinicAddress,
  clinicPhone,
  logoUrl,
  documentName,
  generatedAt,
}: PrintHeaderProps) {
  return (
    <>
      {/* Compact header — fixed, repeats on every printed page (page 2+) */}
      <div className="print-compact-header hidden">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-1.5">
            {logoUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={logoUrl}
                alt=""
                aria-hidden
                width={18}
                height={18}
                style={{ objectFit: "contain", flexShrink: 0 }}
              />
            )}
            <span style={{ fontSize: "11px", fontWeight: 600 }}>{clinicName}</span>
          </div>
          <span style={{ fontSize: "10px", color: "#64748b" }}>{documentName}</span>
        </div>
        <div style={{ borderBottom: "1px solid #cbd5e1", marginTop: "4px" }} />
      </div>

      {/* Full header — inline, naturally on page 1; covers compact header via higher z-index */}
      <div
        className="print-full-header hidden print:block"
        style={{ borderBottom: "2px solid #cbd5e1", paddingBottom: "12px", marginBottom: "0" }}
      >
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            {logoUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={logoUrl}
                alt=""
                aria-hidden
                width={72}
                height={72}
                style={{ objectFit: "contain", flexShrink: 0, width: "72px", height: "72px" }}
              />
            )}
            <div>
              <p style={{ fontSize: "18px", fontWeight: 700, lineHeight: 1.2, letterSpacing: "-0.01em" }}>
                {clinicName}
              </p>
              {clinicAddress && (
                <p
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "4px",
                    fontSize: "11px",
                    color: "#475569",
                    marginTop: "5px",
                  }}
                >
                  <MapPin size={10} aria-hidden />
                  {clinicAddress}
                </p>
              )}
              {clinicPhone && (
                <p
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "4px",
                    fontSize: "11px",
                    color: "#475569",
                    marginTop: "3px",
                  }}
                >
                  <Phone size={10} aria-hidden />
                  {clinicPhone}
                </p>
              )}
            </div>
          </div>
          <div style={{ textAlign: "right", fontSize: "10px", color: "#64748b" }}>
            <p>Generated {generatedAt}</p>
          </div>
        </div>
      </div>
    </>
  );
}
