package ink.pengfei.lvguo.net;

import ink.pengfei.lvguo.App;
import ink.pengfei.lvguo.core.CoreBridge;
import ink.pengfei.lvguo.store.Store;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 本地剧库与 Core 云端账号库双向同步协调器。
 */
public final class LibrarySync implements Store.Sync {
    private static final ExecutorService SYNC_POOL = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "lvguo-sync");
        t.setDaemon(true);
        return t;
    });

    private static volatile boolean initialized;
    private static volatile boolean historyLoaded;
    private static volatile boolean historyOk;
    private static final List<HistoryReady> HISTORY_WAITERS = new ArrayList<>();

    public interface HistoryReady {
        void finished(boolean success);
    }

    private LibrarySync() {}

    public static synchronized void init() {
        if (initialized) return;
        initialized = true;
        Store.setSync(new LibrarySync());
        SYNC_POOL.execute(() -> {
            Session.refreshFromCore();
            pullSyncInternal();
        });
    }

    public static void keepAlive() {
        SYNC_POOL.execute(Session::refreshFromCore);
    }

    public static void keepAliveIfStale() {
        SYNC_POOL.execute(Session::refreshFromCore);
    }

    public static void preloadHistory() {
        SYNC_POOL.execute(LibrarySync::pullSyncInternal);
    }

    public static synchronized boolean historyReady() {
        return historyLoaded;
    }

    public static void whenHistoryReady(HistoryReady callback) {
        if (callback == null) return;
        boolean done;
        boolean ok;
        synchronized (LibrarySync.class) {
            done = historyLoaded;
            ok = historyOk;
            if (!done) HISTORY_WAITERS.add(callback);
        }
        if (done) callback.finished(ok);
    }

    public static void pull() {
        SYNC_POOL.execute(LibrarySync::pullSyncInternal);
    }

    public static void flushProgress() {
        // Core 每次接收 progress.report 时即已同步落盘与排队上云
    }

    public static synchronized String historyClearStatus(long id) {
        return "done";
    }

    private static void pullSyncInternal() {
        boolean ok = false;
        long gen = Session.generation();
        try {
            List<Account.Entry> hist = Account.history(120);
            Store.replaceFromCloudIfCurrent("history", hist, gen);
            if (Session.loggedIn()) {
                List<Account.Entry> favs = Account.favorites();
                Store.replaceFromCloudIfCurrent("fav", favs, gen);
            }
            ok = true;
        } catch (Throwable ignored) {}

        List<HistoryReady> waiters;
        synchronized (LibrarySync.class) {
            historyLoaded = true;
            historyOk = ok;
            waiters = new ArrayList<>(HISTORY_WAITERS);
            HISTORY_WAITERS.clear();
        }
        for (HistoryReady cb : waiters) {
            try { cb.finished(ok); } catch (RuntimeException ignored) {}
        }
    }

    @Override
    public void favorite(String seriesId, boolean add) {
        SYNC_POOL.execute(() -> {
            try {
                if (Session.loggedIn()) Account.setFavorite(seriesId, add);
            } catch (Throwable ignored) {}
        });
    }

    @Override
    public void historyDeleted(List<Store.Item> entries) {
        SYNC_POOL.execute(() -> {
            try {
                Account.deleteHistory(entries);
            } catch (Throwable ignored) {}
        });
    }

    @Override
    public long historyCleared(List<Store.Item> localEntries, long requestedAt) {
        historyDeleted(localEntries);
        return System.currentTimeMillis();
    }

    @Override
    public void progress(String seriesId, String vid, int episodeIndex, int positionMs, int durationMs) {
        SYNC_POOL.execute(() -> {
            try {
                Account.uploadProgress(seriesId, vid, episodeIndex, positionMs, durationMs, 0);
            } catch (Throwable ignored) {}
        });
    }
}
