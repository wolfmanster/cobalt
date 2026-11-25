package com.xmedia.archive.data

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

@Database(entities = [JobEntity::class, MediaEntity::class, TweetCategoryEntity::class, TweetCategoryAssignmentEntity::class,
    SyncedMediaEntity::class, ArchiveImportEntity::class, SyncedCatalogEntity::class], version = 3, exportSchema = false)
abstract class ArchiveDatabase : RoomDatabase() {
    abstract fun dao(): ArchiveDao

    companion object {
        val MIGRATION_1_2 = object : Migration(1, 2) {
            override fun migrate(database: SupportSQLiteDatabase) {
                database.execSQL("CREATE TABLE IF NOT EXISTS `tweet_categories` (`id` TEXT NOT NULL, `name` TEXT NOT NULL, `normalizedName` TEXT NOT NULL, `createdAt` TEXT NOT NULL, PRIMARY KEY(`id`))")
                database.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS `index_tweet_categories_normalizedName` ON `tweet_categories` (`normalizedName`)")
                database.execSQL("CREATE TABLE IF NOT EXISTS `tweet_category_assignments` (`tweetId` TEXT NOT NULL, `categoryId` TEXT NOT NULL, PRIMARY KEY(`tweetId`, `categoryId`), FOREIGN KEY(`categoryId`) REFERENCES `tweet_categories`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE)")
                database.execSQL("CREATE INDEX IF NOT EXISTS `index_tweet_category_assignments_tweetId` ON `tweet_category_assignments` (`tweetId`)")
                database.execSQL("CREATE INDEX IF NOT EXISTS `index_tweet_category_assignments_categoryId` ON `tweet_category_assignments` (`categoryId`)")
            }
        }

        val MIGRATION_2_3 = object : Migration(2, 3) {
            override fun migrate(database: SupportSQLiteDatabase) {
                database.execSQL("CREATE TABLE IF NOT EXISTS synced_media (server TEXT NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL, uri TEXT NOT NULL, contentType TEXT NOT NULL, ready INTEGER NOT NULL, PRIMARY KEY (server, sha256))")
                database.execSQL("CREATE TABLE IF NOT EXISTS archive_imports (server TEXT NOT NULL, jobId TEXT NOT NULL, tweetId TEXT NOT NULL, missing TEXT NOT NULL, permissions TEXT NOT NULL, PRIMARY KEY (server, jobId))")
                database.execSQL("CREATE TABLE IF NOT EXISTS synced_catalog (server TEXT NOT NULL, `key` TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (server, `key`))")
            }
        }

        @Volatile private var instance: ArchiveDatabase? = null

        fun get(context: Context): ArchiveDatabase = instance ?: synchronized(this) {
            instance ?: Room.databaseBuilder(
                context.applicationContext,
                ArchiveDatabase::class.java,
                "x-media-archive.db",
            ).addMigrations(MIGRATION_1_2, MIGRATION_2_3).build().also { instance = it }
        }
    }
}
