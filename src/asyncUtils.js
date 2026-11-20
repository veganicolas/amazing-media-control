import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export function gioAsync(object, method, ...args) {
    return new Promise((resolve, reject) => {
        object[`${method}_async`](...args, (source, result) => {
            try {
                resolve(source[`${method}_finish`](result));
            } catch (e) {
                reject(e);
            }
        });
    });
}

export async function ensureDirAsync(dirFile, cancellable = null) {
    if (!dirFile)
        return;

    if (await fileExistsAsync(dirFile, cancellable))
        return;

    const parent = dirFile.get_parent();
    if (parent) {
        try {
            await ensureDirAsync(parent, cancellable);
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                throw e;
        }
    }

    try {
        await gioAsync(dirFile, 'make_directory', GLib.PRIORITY_DEFAULT, cancellable);
    } catch (e) {
        if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
            throw e;
    }
}

export async function fileExistsAsync(file, cancellable = null) {
    if (!file)
        return false;
    try {
        await gioAsync(
            file,
            'query_info',
            Gio.FILE_ATTRIBUTE_STANDARD_TYPE,
            Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT,
            cancellable
        );
        return true;
    } catch (e) {
        if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            throw e;
        return false;
    }
}

export function resolveLocalGioFile(uriOrPath) {
    if (!uriOrPath)
        return null;
    return uriOrPath.startsWith('file://')
        ? Gio.File.new_for_uri(uriOrPath)
        : Gio.File.new_for_path(uriOrPath);
}

export function createLinkedCancellable(activeSet, externalCancellable = null) {
    const cancellable = new Gio.Cancellable();
    const extSig = externalCancellable
        ? externalCancellable.connect(() => cancellable.cancel())
        : 0;
    if (externalCancellable?.is_cancelled())
        cancellable.cancel();
    activeSet?.add(cancellable);
    return {
        cancellable,
        release() {
            activeSet?.delete(cancellable);
            if (extSig && externalCancellable)
                externalCancellable.disconnect(extSig);
        },
    };
}

async function closeStreamQuietly(stream) {
    if (!stream)
        return;
    try {
        await gioAsync(stream, 'close', GLib.PRIORITY_DEFAULT, null);
    } catch {
        // Ignore stream close errors.
    }
}

async function decodePixbufFromStreamAsync(
    stream,
    width,
    height,
    preserveAspect = true,
    cancellable = null
) {
    if (!stream)
        return null;
    try {
        return await new Promise((resolve, reject) => {
            GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(
                stream,
                width,
                height,
                preserveAspect,
                cancellable,
                (_obj, res) => {
                    try {
                        resolve(GdkPixbuf.Pixbuf.new_from_stream_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    } finally {
        await closeStreamQuietly(stream);
    }
}

export async function decodePixbufFromFileAsync(
    file,
    width,
    height,
    preserveAspect = true,
    cancellable = null
) {
    const stream = await gioAsync(file, 'read', GLib.PRIORITY_DEFAULT, cancellable);
    return decodePixbufFromStreamAsync(stream, width, height, preserveAspect, cancellable);
}

export async function decodePixbufFromBytesAsync(
    bytes,
    width,
    height,
    preserveAspect = true,
    cancellable = null
) {
    const stream = Gio.MemoryInputStream.new_from_bytes(bytes);
    return decodePixbufFromStreamAsync(stream, width, height, preserveAspect, cancellable);
}

export function writeBytesAsync(file, bytes, cancellable = null) {
    return new Promise((resolve, reject) => {
        file.replace_contents_bytes_async(
            bytes,
            null,
            false,
            Gio.FileCreateFlags.REPLACE_DESTINATION,
            cancellable,
            (obj, res) => {
                try {
                    obj.replace_contents_finish(res);
                    resolve();
                } catch (e) {
                    reject(e);
                }
            }
        );
    });
}

export async function pruneDirFilesAsync(
    dirFile,
    { prefix = '', maxFiles = 16, keepPaths = [], cancellable = null } = {}
) {
    if (!dirFile)
        return;
    const keepSet = new Set(keepPaths);
    let enumerator = null;
    try {
        enumerator = await gioAsync(
            dirFile,
            'enumerate_children',
            `${Gio.FILE_ATTRIBUTE_STANDARD_NAME},${Gio.FILE_ATTRIBUTE_TIME_MODIFIED}`,
            Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT,
            cancellable
        );

        const entries = [];
        let pinnedCount = 0;
        while (true) {
            const batch = await gioAsync(
                enumerator,
                'next_files',
                64,
                GLib.PRIORITY_DEFAULT,
                cancellable
            );
            if (!batch || batch.length === 0)
                break;

            for (const info of batch) {
                const name = info.get_name();
                if (prefix && !name.startsWith(prefix))
                    continue;
                const child = dirFile.get_child(name);
                const path = child.get_path();
                if (keepSet.has(path)) {
                    pinnedCount++;
                } else {
                    entries.push({
                        file: child,
                        mtime: info.get_modification_date_time()?.to_unix() ?? 0,
                    });
                }
            }
        }

        entries.sort((a, b) => b.mtime - a.mtime);
        const keepNonPinned = Math.max(0, maxFiles - pinnedCount);
        for (const stale of entries.slice(keepNonPinned)) {
            try {
                await gioAsync(stale.file, 'delete', GLib.PRIORITY_DEFAULT, cancellable);
            } catch {
                // Ignore individual file deletion errors.
            }
        }
    } catch {
        // Non-critical cache cleanup.
    } finally {
        if (enumerator)
            await closeStreamQuietly(enumerator);
    }
}
