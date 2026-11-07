export class ApiError extends Error {
  status: number;
  data: Record<string, unknown>;

  constructor(status: number, message: string, data: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

type Options = Omit<RequestInit, 'body'> & { body?: unknown };

export async function api<T>(path: string, options: Options = {}): Promise<T> {
  const { body, headers, ...rest } = options;
  const isForm = body instanceof FormData;
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...rest,
    headers: {
      ...(isForm ? {} : { 'Content-Type': 'application/json' }),
      ...(headers || {}),
    },
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });

  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new ApiError(
      response.status,
      typeof data.error === 'string' ? data.error : 'Не удалось выполнить запрос',
      data,
    );
  }
  return data as T;
}

export interface UploadHandle {
  promise: Promise<{ project: unknown }>;
  cancel: () => void;
}

export function uploadSurface(
  projectId: string,
  key: string,
  file: File,
  onProgress: (percent: number) => void,
  videoSceneId?: string,
): UploadHandle {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<{ project: unknown }>((resolve, reject) => {
    const scenePath = videoSceneId ? `/video-scenes/${encodeURIComponent(videoSceneId)}` : '';
    xhr.open('POST', `/api/projects/${encodeURIComponent(projectId)}${scenePath}/surfaces/${encodeURIComponent(key)}`);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(xhr.responseText || '{}');
      } catch {
        /* ignore */
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data as { project: unknown });
      } else {
        reject(
          new ApiError(
            xhr.status,
            typeof data.error === 'string' ? data.error : 'Не удалось загрузить видео',
            data,
          ),
        );
      }
    };
    xhr.onerror = () => reject(new ApiError(0, 'Сеть недоступна, попробуйте ещё раз'));
    xhr.onabort = () => reject(new ApiError(0, 'Загрузка отменена'));
    const form = new FormData();
    form.append('file', file);
    xhr.send(form);
  });

  return { promise, cancel: () => xhr.abort() };
}
