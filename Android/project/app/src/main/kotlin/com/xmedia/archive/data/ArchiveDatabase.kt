package com.xmedia.archive.data

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

@Database(entities = [JobEntity::class, MediaEntity::class], version = 1, exportSchema = false)
abstract class ArchiveDatabase : RoomDatabase() {
    abstract fun dao(): ArchiveDao

    companion object {
        @Volatile private var instance: ArchiveDatabase? = null

        fun get(context: Context): ArchiveDatabase = instance ?: synchronized(this) {
            instance ?: Room.databaseBuilder(
                context.applicationContext,
                ArchiveDatabase::class.java,
                "x-media-archive.db",
            ).build().also { instance = it }
        }
    }
}
