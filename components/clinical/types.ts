export type ClinicalDoctorOption = {
  id: string;
  fullName: string;
  departmentId: string | null;
};

export type ClinicalPatientOption = {
  id: string;
  fullName: string;
  fileNumber?: string | null;
};

export type ClinicalAppointmentOption = {
  id: string;
  patientId: string;
  label: string;
};

export type DrugCatalogOption = {
  id: string;
  name: string;
  form: string | null;
  strength: string | null;
  isControlled: boolean;
  departmentIds: string[];
};

export type LabTestCatalogOption = {
  id: string;
  name: string;
  departmentIds: string[];
};
